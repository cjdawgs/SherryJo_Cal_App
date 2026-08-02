"""Run a bounded, read-only HTTP and WebSocket capacity probe."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import websockets


DEFAULT_BASE_URL = "http://127.0.0.1:8000"
DEFAULT_TOKEN_ENV = "CAPACITY_PROBE_BEARER_TOKEN"
LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
MAX_REQUESTS_PER_CASE = 200
MAX_CONCURRENCY = 20
MAX_WEBSOCKET_SAMPLES = 20
MAX_WARMUP_REQUESTS = 20
USER_AGENT = "SherryJo-capacity-probe/1.0"


@dataclass(frozen=True)
class ProbeCase:
    name: str
    path: str
    headers: dict[str, str]


def validate_target(base_url: str, allow_remote: bool) -> str:
    normalized = base_url.rstrip("/")
    parsed = urlsplit(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("base URL must be an absolute HTTP(S) URL")
    if parsed.hostname not in LOCAL_HOSTS and not allow_remote:
        raise ValueError("remote probes require --allow-remote")
    if parsed.hostname not in LOCAL_HOSTS and parsed.scheme != "https":
        raise ValueError("remote probes require HTTPS")
    return normalized


def build_cases(token: str | None) -> tuple[list[ProbeCase], list[str]]:
    cases = [
        ProbeCase("health", "/health", {}),
        ProbeCase("static_javascript", "/static/admin.js", {}),
    ]
    skipped = []
    if token:
        authenticated_headers = {"Authorization": f"Bearer {token}"}
        cases.extend(
            [
                ProbeCase(
                "calendar_read",
                "/calendar/unified?range_days=7",
                    authenticated_headers,
                ),
                ProbeCase("scheduler_health", "/accounts/sync-status", authenticated_headers),
                ProbeCase("sync_rollups", "/accounts/sync-rollups?days=7", authenticated_headers),
            ]
        )
    else:
        skipped.extend(
            [
                "calendar_read: token environment variable is not configured",
                "scheduler_health: token environment variable is not configured",
                "sync_rollups: token environment variable is not configured",
            ]
        )
    return cases, skipped


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        raise ValueError("percentile requires at least one value")
    ordered = sorted(values)
    rank = max(1, math.ceil(quantile * len(ordered)))
    return ordered[rank - 1]


def summarize_samples(name: str, samples: list[dict]) -> dict:
    latencies = [float(sample["latency_ms"]) for sample in samples]
    successes = [sample for sample in samples if sample["status"] == 200]
    statuses: dict[str, int] = {}
    for sample in samples:
        key = str(sample["status"])
        statuses[key] = statuses.get(key, 0) + 1
    return {
        "name": name,
        "requests": len(samples),
        "successes": len(successes),
        "failures": len(samples) - len(successes),
        "success_rate": len(successes) / len(samples),
        "latency_ms": {
            "min": round(min(latencies), 3),
            "p50": round(percentile(latencies, 0.50), 3),
            "p95": round(percentile(latencies, 0.95), 3),
            "p99": round(percentile(latencies, 0.99), 3),
            "max": round(max(latencies), 3),
        },
        "response_bytes": sum(int(sample["response_bytes"]) for sample in samples),
        "statuses": statuses,
    }


async def _http_sample(
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    case: ProbeCase,
) -> dict:
    started = time.perf_counter()
    try:
        async with semaphore:
            response = await client.get(case.path, headers=case.headers)
        status = response.status_code
        response_bytes = len(response.content)
        error = None
    except httpx.HTTPError as exc:
        status = None
        response_bytes = 0
        error = type(exc).__name__
    return {
        "status": status,
        "response_bytes": response_bytes,
        "latency_ms": (time.perf_counter() - started) * 1000,
        "error": error,
    }


async def run_http_probe(
    base_url: str,
    cases: list[ProbeCase],
    requests_per_case: int,
    concurrency: int,
    warmup_requests: int,
) -> list[dict]:
    semaphore = asyncio.Semaphore(concurrency)
    timeout = httpx.Timeout(45.0)
    limits = httpx.Limits(max_connections=concurrency, max_keepalive_connections=concurrency)
    headers = {"Accept": "*/*", "User-Agent": USER_AGENT}
    async with httpx.AsyncClient(
        base_url=base_url,
        timeout=timeout,
        limits=limits,
        headers=headers,
        follow_redirects=False,
    ) as client:
        summaries = []
        for case in cases:
            for _ in range(warmup_requests):
                await _http_sample(client, semaphore, case)
            samples = await asyncio.gather(
                *(_http_sample(client, semaphore, case) for _ in range(requests_per_case))
            )
            summaries.append(summarize_samples(case.name, samples))
        return summaries


def websocket_url(base_url: str) -> str:
    parsed = urlsplit(base_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    host = parsed.netloc
    return f"{scheme}://{host}/ws?ticket=invalid-capacity-probe-ticket"


async def _websocket_sample(url: str) -> dict:
    started = time.perf_counter()
    try:
        async with websockets.connect(
            url,
            open_timeout=30,
            proxy=None,
            user_agent_header=USER_AGENT,
        ):
            status = 101
            error = "unexpected_accept"
    except websockets.exceptions.InvalidStatus as exc:
        status = exc.response.status_code
        error = None if status == 403 else "unexpected_status"
    except Exception as exc:
        status = None
        error = type(exc).__name__
    return {
        "status": status,
        "latency_ms": (time.perf_counter() - started) * 1000,
        "error": error,
    }


async def run_websocket_probe(base_url: str, sample_count: int) -> dict:
    samples = []
    for _ in range(sample_count):
        samples.append(await _websocket_sample(websocket_url(base_url)))
    latencies = [float(sample["latency_ms"]) for sample in samples]
    successes = sum(sample["status"] == 403 for sample in samples)
    return {
        "name": "websocket_rejection",
        "requests": sample_count,
        "successes": successes,
        "failures": sample_count - successes,
        "success_rate": successes / sample_count,
        "latency_ms": {
            "p50": round(percentile(latencies, 0.50), 3),
            "p95": round(percentile(latencies, 0.95), 3),
            "p99": round(percentile(latencies, 0.99), 3),
            "max": round(max(latencies), 3),
        },
        "expected_status": 403,
        "statuses": [sample["status"] for sample in samples],
        "errors": [sample["error"] for sample in samples if sample["error"]],
    }


async def run_probe(args: argparse.Namespace) -> dict:
    base_url = validate_target(args.base_url, args.allow_remote)
    token = os.getenv(args.token_env, "").strip() or None
    cases, skipped = build_cases(token)
    if args.require_calendar and not token:
        raise ValueError(f"{args.token_env} must be configured when --require-calendar is used")

    http_results, websocket_result = await asyncio.gather(
        run_http_probe(
            base_url,
            cases,
            args.requests_per_case,
            args.concurrency,
            args.warmup_requests,
        ),
        run_websocket_probe(base_url, args.websocket_samples),
    )
    passed = all(result["failures"] == 0 for result in http_results)
    passed = passed and websocket_result["failures"] == 0
    return {
        "target": base_url,
        "passed": passed,
        "read_only": True,
        "requests_per_http_case": args.requests_per_case,
        "warmup_requests_per_http_case": args.warmup_requests,
        "concurrency": args.concurrency,
        "authenticated_calendar_read": bool(token),
        "skipped": skipped,
        "http": http_results,
        "websocket": websocket_result,
    }


def bounded_int(value: str, minimum: int, maximum: int, label: str) -> int:
    parsed = int(value)
    if parsed < minimum or parsed > maximum:
        raise argparse.ArgumentTypeError(f"{label} must be between {minimum} and {maximum}")
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--allow-remote", action="store_true")
    parser.add_argument("--token-env", default=DEFAULT_TOKEN_ENV)
    parser.add_argument("--require-calendar", action="store_true")
    parser.add_argument(
        "--requests-per-case",
        type=lambda value: bounded_int(value, 1, MAX_REQUESTS_PER_CASE, "requests per case"),
        default=10,
    )
    parser.add_argument(
        "--concurrency",
        type=lambda value: bounded_int(value, 1, MAX_CONCURRENCY, "concurrency"),
        default=4,
    )
    parser.add_argument(
        "--websocket-samples",
        type=lambda value: bounded_int(value, 1, MAX_WEBSOCKET_SAMPLES, "WebSocket samples"),
        default=3,
    )
    parser.add_argument(
        "--warmup-requests",
        type=lambda value: bounded_int(value, 0, MAX_WARMUP_REQUESTS, "warmup requests"),
        default=2,
    )
    parser.add_argument("--json-output")
    args = parser.parse_args()

    try:
        report = asyncio.run(run_probe(args))
    except ValueError as exc:
        parser.error(str(exc))

    output = json.dumps(report, indent=2)
    print(output)
    if args.json_output:
        output_path = Path(args.json_output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(output + "\n", encoding="utf-8")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
"""Compare the live Cloudflare shadow endpoint with the Render origin."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Iterable
from urllib.parse import urlsplit, urlunsplit

import websockets


DEFAULT_RENDER_URL = "https://sherryjo-cal-app.onrender.com"
DEFAULT_CLOUDFLARE_URL = "https://sherryjo-cal-app.realty-cal.workers.dev"
USER_AGENT = "curl/8.10.1 SherryJo-shadow-parity/1.0"


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


@dataclass(frozen=True)
class HttpCase:
    name: str
    method: str
    path: str
    body: bytes | None = None
    headers: dict[str, str] | None = None
    compare_body: bool = True


@dataclass(frozen=True)
class HttpResult:
    status: int
    content_type: str | None
    location: str | None
    set_cookie: tuple[str, ...]
    edge_marker: str | None
    body: bytes


def _multipart_probe() -> tuple[bytes, str]:
    boundary = "----SherryJoParityBoundary"
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="parity.csv"\r\n'
        "Content-Type: text/csv\r\n\r\n"
        "title,start\nParity Probe,2026-08-01\n"
        f"--{boundary}--\r\n"
    ).encode("utf-8")
    return body, f"multipart/form-data; boundary={boundary}"


def _cases(cloudflare_url: str) -> list[HttpCase]:
    multipart_body, multipart_type = _multipart_probe()
    return [
        HttpCase("health_get", "GET", "/health"),
        HttpCase("health_head", "HEAD", "/health"),
        HttpCase("health_with_cookie", "GET", "/health", headers={"Cookie": "parity_probe=1"}),
        HttpCase("schema_health", "GET", "/health/schema", compare_body=False),
        HttpCase("favicon", "GET", "/favicon.ico"),
        HttpCase("admin_redirect", "GET", "/admin"),
        HttpCase("login_page", "GET", "/login"),
        HttpCase("static_javascript", "GET", "/static/admin.js"),
        HttpCase("openapi_large_response", "GET", "/openapi.json"),
        HttpCase(
            "invalid_login",
            "POST",
            "/auth/login",
            json.dumps({"email": "parity-probe@example.invalid", "password": "invalid"}).encode("utf-8"),
            {"Content-Type": "application/json"},
        ),
        HttpCase(
            "google_callback_invalid_state",
            "GET",
            "/auth/google/callback?code=shadow-invalid&state=shadow-invalid",
        ),
        HttpCase(
            "microsoft_callback_invalid_state",
            "GET",
            "/ms/callback?code=shadow-invalid&state=shadow-invalid",
        ),
        HttpCase("protected_api", "GET", "/admin/system/overview"),
        HttpCase(
            "multipart_auth_rejection",
            "POST",
            "/calendar/import-events",
            multipart_body,
            {"Content-Type": multipart_type},
        ),
        HttpCase(
            "cors_preflight",
            "OPTIONS",
            "/health",
            headers={
                "Origin": cloudflare_url,
                "Access-Control-Request-Method": "GET",
            },
        ),
    ]


def _request(opener, origin: str, case: HttpCase) -> HttpResult:
    headers = {"Accept": "*/*", "User-Agent": USER_AGENT, **(case.headers or {})}
    request = urllib.request.Request(
        f"{origin}{case.path}",
        data=case.body,
        headers=headers,
        method=case.method,
    )
    try:
        response = opener.open(request, timeout=45)
    except urllib.error.HTTPError as error:
        response = error

    with response:
        body = response.read()
        return HttpResult(
            status=response.status,
            content_type=response.headers.get("content-type"),
            location=response.headers.get("location"),
            set_cookie=tuple(response.headers.get_all("set-cookie") or ()),
            edge_marker=response.headers.get("x-sherryjo-edge"),
            body=body,
        )


def _normalize_location(location: str | None, origins: Iterable[str]) -> str | None:
    if not location:
        return None
    for origin in origins:
        if location.startswith(origin):
            return location[len(origin):] or "/"
    parsed = urlsplit(location)
    if parsed.scheme and parsed.netloc:
        return urlunsplit((parsed.scheme, "<HOST>", parsed.path, parsed.query, parsed.fragment))
    return location


def _normalize_body(body: bytes, origins: Iterable[str]) -> bytes:
    value = body
    for origin in origins:
        value = value.replace(origin.encode("utf-8"), b"<PUBLIC_ORIGIN>")
    return value


def _digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()[:12]


def run_http_parity(render_url: str, cloudflare_url: str) -> tuple[list[dict], list[str]]:
    opener = urllib.request.build_opener(NoRedirectHandler)
    rows = []
    failures = []
    origins = (render_url, cloudflare_url)

    for case in _cases(cloudflare_url):
        render = _request(opener, render_url, case)
        cloudflare = _request(opener, cloudflare_url, case)
        checks = {
            "status": render.status == cloudflare.status,
            "content_type": render.content_type == cloudflare.content_type,
            "location": _normalize_location(render.location, origins)
            == _normalize_location(cloudflare.location, origins),
            "set_cookie": render.set_cookie == cloudflare.set_cookie,
            "body": not case.compare_body
            or _normalize_body(render.body, origins) == _normalize_body(cloudflare.body, origins),
            "edge_marker": cloudflare.edge_marker == "cloudflare",
        }
        failed_checks = [name for name, passed in checks.items() if not passed]
        if failed_checks:
            failures.append(f"{case.name}: {', '.join(failed_checks)}")
        rows.append(
            {
                "case": case.name,
                "passed": not failed_checks,
                "failed_checks": failed_checks,
                "render_status": render.status,
                "cloudflare_status": cloudflare.status,
                "render_bytes": len(render.body),
                "cloudflare_bytes": len(cloudflare.body),
                "render_sha256": _digest(_normalize_body(render.body, origins)),
                "cloudflare_sha256": _digest(_normalize_body(cloudflare.body, origins)),
            }
        )

    return rows, failures


def run_worker_edge_health(render_url: str, cloudflare_url: str) -> tuple[dict, list[str]]:
    opener = urllib.request.build_opener(NoRedirectHandler)
    case = HttpCase("worker_edge_health", "GET", "/__edge/health")
    render = _request(opener, render_url, case)
    cloudflare = _request(opener, cloudflare_url, case)
    expected_body = {
        "status": "ok",
        "platform": "cloudflare",
        "mode": "render-origin-proxy",
    }
    try:
        cloudflare_body = json.loads(cloudflare.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        cloudflare_body = None

    checks = {
        "render_does_not_own_route": render.status == 404,
        "cloudflare_status": cloudflare.status == 200,
        "cloudflare_body": cloudflare_body == expected_body,
    }
    failed_checks = [name for name, passed in checks.items() if not passed]
    row = {
        "case": case.name,
        "passed": not failed_checks,
        "failed_checks": failed_checks,
        "render_status": render.status,
        "cloudflare_status": cloudflare.status,
        "cloudflare_sha256": _digest(cloudflare.body),
    }
    failures = [] if not failed_checks else [f"{case.name}: {', '.join(failed_checks)}"]
    return row, failures


def run_worker_native_status(render_url: str, cloudflare_url: str) -> tuple[dict, list[str]]:
    opener = urllib.request.build_opener(NoRedirectHandler)
    case = HttpCase("worker_native_platform_status", "GET", "/api/platform/status")
    render = _request(opener, render_url, case)
    cloudflare = _request(opener, cloudflare_url, case)
    expected_body = {
        "status": "ok",
        "platform": "cloudflare-worker",
        "mode": "worker-native",
        "edgeProxyAuthConfigured": True,
    }
    try:
        cloudflare_body = json.loads(cloudflare.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        cloudflare_body = None

    required_fields_match = isinstance(cloudflare_body, dict) and all(
        cloudflare_body.get(key) == value for key, value in expected_body.items()
    )

    checks = {
        "render_does_not_own_route": render.status == 404,
        "cloudflare_status": cloudflare.status == 200,
        "cloudflare_body": required_fields_match,
    }
    failed_checks = [name for name, passed in checks.items() if not passed]
    row = {
        "case": case.name,
        "passed": not failed_checks,
        "failed_checks": failed_checks,
        "render_status": render.status,
        "cloudflare_status": cloudflare.status,
        "cloudflare_sha256": _digest(cloudflare.body),
    }
    failures = [] if not failed_checks else [f"{case.name}: {', '.join(failed_checks)}"]
    return row, failures


async def _websocket_status(url: str) -> int | None:
    try:
        async with websockets.connect(
            url,
            open_timeout=30,
            proxy=None,
            user_agent_header=USER_AGENT,
        ):
            return 101
    except websockets.exceptions.InvalidStatus as error:
        return error.response.status_code


async def run_websocket_parity(render_url: str, cloudflare_url: str) -> tuple[dict, list[str]]:
    render_ws = render_url.replace("https://", "wss://", 1) + "/ws?ticket=invalid-parity-ticket"
    cloudflare_ws = cloudflare_url.replace("https://", "wss://", 1) + "/ws?ticket=invalid-parity-ticket"
    render_status, cloudflare_status = await asyncio.gather(
        _websocket_status(render_ws),
        _websocket_status(cloudflare_ws),
    )
    passed = render_status == cloudflare_status == 403
    row = {
        "case": "websocket_invalid_token_rejection",
        "passed": passed,
        "render_status": render_status,
        "cloudflare_status": cloudflare_status,
    }
    return row, [] if passed else ["websocket_invalid_token_rejection: status"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--render-url", default=DEFAULT_RENDER_URL)
    parser.add_argument("--cloudflare-url", default=DEFAULT_CLOUDFLARE_URL)
    parser.add_argument("--json-output")
    args = parser.parse_args()

    render_url = args.render_url.rstrip("/")
    cloudflare_url = args.cloudflare_url.rstrip("/")
    rows, failures = run_http_parity(render_url, cloudflare_url)
    edge_health_row, edge_health_failures = run_worker_edge_health(render_url, cloudflare_url)
    rows.append(edge_health_row)
    failures.extend(edge_health_failures)
    native_row, native_failures = run_worker_native_status(render_url, cloudflare_url)
    rows.append(native_row)
    failures.extend(native_failures)
    websocket_row, websocket_failures = asyncio.run(
        run_websocket_parity(render_url, cloudflare_url)
    )
    rows.append(websocket_row)
    failures.extend(websocket_failures)

    report = {
        "render_url": render_url,
        "cloudflare_url": cloudflare_url,
        "passed": not failures,
        "passed_checks": sum(1 for row in rows if row["passed"]),
        "total_checks": len(rows),
        "failures": failures,
        "results": rows,
        "known_platform_caveats": [
            "workers.dev returns Cloudflare error 1010 for Python urllib's default user-agent; browser and curl identities pass.",
            "Operator-authenticated read/write, multipart import, and WebSocket evidence is recorded separately without storing a token.",
        ],
    }

    output = json.dumps(report, indent=2)
    print(output)
    if args.json_output:
        with open(args.json_output, "w", encoding="utf-8") as handle:
            handle.write(output + "\n")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
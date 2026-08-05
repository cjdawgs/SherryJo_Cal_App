"""Collect a secret-safe production baseline for migration decision gates."""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from deployment.platform_contract import RENDER_REQUIRED


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RENDER_URL = "https://sherryjo-cal-app.onrender.com"
DEFAULT_EDGE_URL = "https://sherryjo-cal-app.realty-cal.workers.dev"
USER_AGENT = "SherryJo-Baseline-Evidence/1.0"

SENSITIVE_ENVIRONMENT_NAMES = tuple(
    sorted(
        {
            *RENDER_REQUIRED,
            "AUTHORIZATION",
            "BASELINE_BEARER_TOKEN",
            "CLOUDFLARE_API_TOKEN",
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "RENDER_API_KEY",
        }
    )
)

FORBIDDEN_ENVIRONMENT_NAMES = (
    "ADMIN_SETUP_CODE",
    "BASELINE_BEARER_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "DATABASE_URL",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GOOGLE_CLIENT_SECRET",
    "JWT_SECRET_KEY",
    "MS_CLIENT_SECRET",
    "RENDER_API_KEY",
    "TOKEN_ENCRYPTION_KEY",
)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_json(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return _sha256_bytes(encoded)


def safe_url(value: str) -> str:
    """Return a URL without credentials, query parameters, or fragments."""
    parsed = urlsplit(str(value or "").strip())
    if not parsed.scheme or not parsed.hostname:
        raise ValueError("Expected an absolute URL")
    host = parsed.hostname
    if parsed.port:
        host = f"{host}:{parsed.port}"
    return urlunsplit((parsed.scheme, host, parsed.path.rstrip("/"), "", ""))


def environment_presence(environment: dict[str, str] | None = None) -> dict[str, bool]:
    environment = dict(os.environ) if environment is None else environment
    return {name: bool(str(environment.get(name, "") or "").strip()) for name in SENSITIVE_ENVIRONMENT_NAMES}


def _request_json(url: str, bearer_token: str | None = None, timeout: float = 15.0) -> tuple[int, Any, bytes]:
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if bearer_token:
        headers["Authorization"] = f"Bearer {bearer_token}"
    request = Request(url, headers=headers, method="GET")
    try:
        with urlopen(request, timeout=timeout) as response:
            body = response.read()
            status = int(getattr(response, "status", None) or response.getcode() or 200)
    except HTTPError as exc:
        body = exc.read()
        status = int(exc.code)
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        payload = None
    return status, payload, body


def _safe_health(payload: Any) -> dict[str, Any]:
    payload = payload if isinstance(payload, dict) else {}
    return {
        "status": payload.get("status"),
        "app": payload.get("app"),
        "schema_status": payload.get("schema_status"),
        "platform": payload.get("platform"),
        "mode": payload.get("mode"),
    }


def _safe_openapi(payload: Any) -> dict[str, Any]:
    payload = payload if isinstance(payload, dict) else {}
    info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
    paths = payload.get("paths") if isinstance(payload.get("paths"), dict) else {}
    schemas = payload.get("components", {}).get("schemas", {}) if isinstance(payload.get("components"), dict) else {}
    return {
        "title": info.get("title"),
        "version": info.get("version"),
        "path_count": len(paths),
        "schema_count": len(schemas) if isinstance(schemas, dict) else 0,
        "contract_sha256": _sha256_json(payload) if payload else None,
    }


def _safe_probe(path: str, status: int, payload: Any, body: bytes) -> dict[str, Any]:
    if path == "/openapi.json":
        summary = _safe_openapi(payload)
    else:
        summary = _safe_health(payload)
    return {
        "http_status": status,
        "content_bytes": len(body),
        "content_sha256": _sha256_bytes(body),
        "summary": summary,
    }


def collect_public_target(base_url: str, paths: tuple[str, ...]) -> dict[str, Any]:
    target = {"base_url": safe_url(base_url), "probes": {}}
    for path in paths:
        url = urljoin(f"{safe_url(base_url)}/", path.lstrip("/"))
        try:
            status, payload, body = _request_json(url)
            target["probes"][path] = _safe_probe(path, status, payload, body)
        except (TimeoutError, URLError, OSError) as exc:
            target["probes"][path] = {"error_type": type(exc).__name__}
    return target


def _safe_deployment(payload: Any) -> dict[str, Any]:
    payload = payload if isinstance(payload, dict) else {}
    return {
        "current_commit": payload.get("current_commit"),
        "current_commit_source": payload.get("current_commit_source"),
        "github_latest_commit": payload.get("github_latest_commit"),
        "status": payload.get("status"),
        "active_platform": payload.get("active_platform"),
        "github_http_status": payload.get("github_http_status"),
    }


def _safe_scheduler(payload: Any) -> dict[str, Any]:
    payload = payload if isinstance(payload, dict) else {}
    adaptive = payload.get("adaptive_backoff") if isinstance(payload.get("adaptive_backoff"), dict) else {}
    operation_ledger = payload.get("operation_ledger") if isinstance(payload.get("operation_ledger"), dict) else {}
    efficiency = payload.get("efficiency") if isinstance(payload.get("efficiency"), dict) else {}
    cache = payload.get("google_calendar_list_cache") if isinstance(payload.get("google_calendar_list_cache"), dict) else {}
    return {
        "running": payload.get("running"),
        "owner": payload.get("owner"),
        "execution_enabled": payload.get("execution_enabled"),
        "last_started_at": payload.get("last_started_at"),
        "last_finished_at": payload.get("last_finished_at"),
        "has_last_error": bool(payload.get("last_error")),
        "next_run_at": payload.get("next_run_at"),
        "frequency_minutes": payload.get("frequency_minutes"),
        "apple_min_frequency_minutes": payload.get("apple_min_frequency_minutes"),
        "adaptive_backoff": {
            "enabled": adaptive.get("enabled"),
            "max_minutes": adaptive.get("max_minutes"),
            "tracked_users": adaptive.get("tracked_users"),
            "users_in_backoff": adaptive.get("users_in_backoff"),
            "last_rollup_persisted_at": adaptive.get("last_rollup_persisted_at"),
        },
        "operation_ledger": {
            "available": operation_ledger.get("available"),
            "window_hours": operation_ledger.get("window_hours"),
            "window_started_at": operation_ledger.get("window_started_at"),
            "captured_at": operation_ledger.get("captured_at"),
            "total_operations": operation_ledger.get("total_operations"),
            "created_in_window": operation_ledger.get("created_in_window"),
            "by_status": operation_ledger.get("by_status") if isinstance(operation_ledger.get("by_status"), dict) else {},
            "by_operation_type": operation_ledger.get("by_operation_type") if isinstance(operation_ledger.get("by_operation_type"), dict) else {},
        },
        "efficiency": {
            key: efficiency.get(key)
            for key in ("changes", "no_changes", "total_cycles", "change_ratio", "no_change_ratio")
        },
        "google_calendar_list_cache": {
            key: cache.get(key)
            for key in ("enabled", "ttl_seconds", "hits", "misses", "total_lookups", "hit_ratio", "cache_entries")
        },
    }


def _safe_rollups(payload: Any) -> dict[str, Any]:
    payload = payload if isinstance(payload, dict) else {}
    rows = payload.get("rows") if isinstance(payload.get("rows"), list) else []
    safe_rows = []
    allowed = {
        "snapshot_date",
        "week_start_date",
        "changes",
        "no_changes",
        "total_cycles",
        "change_ratio",
        "no_change_ratio",
        "google_cache_hits",
        "google_cache_misses",
        "google_cache_total_lookups",
        "google_cache_hit_ratio",
        "google_cache_entries",
        "updated_at",
    }
    for row in rows:
        if isinstance(row, dict):
            safe_rows.append({key: row.get(key) for key in allowed})
    current_week = payload.get("current_week") if isinstance(payload.get("current_week"), dict) else {}
    return {
        "row_count": len(safe_rows),
        "rows": safe_rows,
        "current_week": {
            "week_start_date": current_week.get("week_start_date"),
            "days_present": current_week.get("days_present"),
            "avg_no_change_ratio": current_week.get("avg_no_change_ratio"),
            "avg_google_cache_hit_ratio": current_week.get("avg_google_cache_hit_ratio"),
        },
    }


def collect_authenticated_baseline(base_url: str, bearer_token: str) -> dict[str, Any]:
    if not bearer_token:
        return {"configured": False}
    result: dict[str, Any] = {"configured": True, "base_url": safe_url(base_url), "probes": {}}
    probes = (
        ("/admin/system/overview", "admin"),
        ("/accounts/sync-status", "sync_status"),
        ("/accounts/sync-rollups?days=28", "sync_rollups"),
    )
    for path, name in probes:
        url = urljoin(f"{safe_url(base_url)}/", path.lstrip("/"))
        try:
            status, payload, _ = _request_json(url, bearer_token=bearer_token)
            safe_payload: dict[str, Any]
            if name == "admin":
                source = payload if isinstance(payload, dict) else {}
                safe_payload = {
                    "table_count": source.get("table_count"),
                    "tables": source.get("tables") if isinstance(source.get("tables"), list) else [],
                    "deployment": _safe_deployment(source.get("deployment")),
                }
            elif name == "sync_status":
                source = payload if isinstance(payload, dict) else {}
                safe_payload = {"scheduler": _safe_scheduler(source.get("scheduler")), "account_count": len(source.get("accounts", [])) if isinstance(source.get("accounts"), list) else 0}
            else:
                safe_payload = _safe_rollups(payload)
            result["probes"][name] = {"http_status": status, "summary": safe_payload}
        except (TimeoutError, URLError, OSError) as exc:
            result["probes"][name] = {"error_type": type(exc).__name__}
    return result


def collect_database_baseline(database_url: str) -> dict[str, Any]:
    """Collect schema and row-count metadata without reading row values."""
    from sqlalchemy import MetaData, Table, create_engine, func, inspect, select, text

    connect_args = {"sslmode": "require"} if database_url.startswith("postgresql") else {}
    engine = create_engine(database_url, pool_pre_ping=True, connect_args=connect_args)
    dialect = engine.dialect.name
    try:
        row_counts: dict[str, Any] = {}
        metadata = MetaData()
        with engine.connect() as connection:
            if dialect == "postgresql":
                connection.execute(text("SET TRANSACTION READ ONLY"))
            inspector = inspect(connection)
            table_names = sorted(inspector.get_table_names())
            for name in table_names:
                try:
                    table = Table(name, metadata, autoload_with=connection)
                    count = connection.execute(select(func.count()).select_from(table)).scalar_one()
                    row_counts[name] = int(count)
                except Exception as exc:
                    row_counts[name] = {"error_type": type(exc).__name__}
            revision = None
            if "alembic_version" in table_names:
                try:
                    revision = connection.execute(text("SELECT version_num FROM alembic_version LIMIT 1")).scalar_one_or_none()
                except Exception:
                    revision = None
        return {
            "dialect": dialect,
            "table_count": len(table_names),
            "tables": table_names,
            "row_counts": row_counts,
            "alembic_revision": revision,
        }
    finally:
        engine.dispose()


def collect_repository_baseline() -> dict[str, Any]:
    commit = None
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=REPOSITORY_ROOT,
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
        if result.returncode == 0:
            commit = result.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        commit = None

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    config = Config(str(REPOSITORY_ROOT / "alembic.ini"))
    script = ScriptDirectory.from_config(config)
    return {
        "git_commit": commit,
        "alembic_heads": sorted(script.get_heads()),
    }


def assert_secret_safe(snapshot: Any, forbidden_values: list[str]) -> None:
    serialized = json.dumps(snapshot, sort_keys=True, default=str)
    leaked = [value for value in forbidden_values if value and value in serialized]
    if leaked:
        raise ValueError(f"Baseline evidence contains {len(leaked)} forbidden value(s)")


def build_snapshot(
    render_url: str,
    edge_url: str,
    environment: dict[str, str] | None = None,
    bearer_token: str | None = None,
    include_database: bool = False,
) -> dict[str, Any]:
    environment = dict(os.environ) if environment is None else environment
    snapshot: dict[str, Any] = {
        "generated_at": _utc_now().isoformat(),
        "repository": collect_repository_baseline(),
        "environment_presence": environment_presence(environment),
        "targets": {
            "render": collect_public_target(render_url, ("/health", "/openapi.json")),
            "cloudflare": collect_public_target(edge_url, ("/__edge/health", "/health", "/api/platform/status", "/openapi.json")),
        },
        "authenticated": collect_authenticated_baseline(render_url, bearer_token or ""),
    }
    if include_database:
        database_url = str(environment.get("DATABASE_URL", "") or "").strip()
        if not database_url:
            raise ValueError("DATABASE_URL is required with --include-database")
        snapshot["database"] = collect_database_baseline(database_url)
    forbidden_values = [str(environment.get(name, "") or "") for name in FORBIDDEN_ENVIRONMENT_NAMES]
    if bearer_token:
        forbidden_values.append(bearer_token)
    assert_secret_safe(snapshot, forbidden_values)
    return snapshot


def _markdown(snapshot: dict[str, Any]) -> str:
    lines = [
        "# Production baseline evidence",
        "",
        f"Generated: `{snapshot['generated_at']}`",
        f"Repository commit: `{snapshot['repository'].get('git_commit') or 'unknown'}`",
        f"Alembic heads: `{', '.join(snapshot['repository'].get('alembic_heads', [])) or 'unknown'}`",
        "",
        "## Public targets",
        "",
        "| Target | URL | Probe | HTTP | Status | Schema | SHA-256 |",
        "| --- | --- | --- | ---: | --- | --- | --- |",
    ]
    for target_name, target in snapshot.get("targets", {}).items():
        for path, probe in target.get("probes", {}).items():
            summary = probe.get("summary", {})
            lines.append(
                f"| {target_name} | {target.get('base_url')} | `{path}` | {probe.get('http_status', 'error')} | "
                f"{summary.get('status', '')} | {summary.get('schema_status', '')} | `{probe.get('content_sha256', '')}` |"
            )
    lines.extend(
        [
            "",
            "## Environment presence",
            "",
            "Only presence is recorded; values are never included.",
            "",
        ]
    )
    for name, present in snapshot.get("environment_presence", {}).items():
        lines.append(f"- `{name}`: {'configured' if present else 'not configured'}")
    return "\n".join(lines) + "\n"


def write_snapshot(snapshot: dict[str, Any], output_dir: Path) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = _utc_now().strftime("%Y%m%dT%H%M%SZ")
    json_path = output_dir / f"production-baseline-{timestamp}.json"
    markdown_path = output_dir / f"production-baseline-{timestamp}.md"
    json_path.write_text(json.dumps(snapshot, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")
    markdown_path.write_text(_markdown(snapshot), encoding="utf-8")
    return json_path, markdown_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--render-url", default=os.getenv("RENDER_BASE_URL", DEFAULT_RENDER_URL))
    parser.add_argument("--edge-url", default=os.getenv("CLOUDFLARE_EDGE_URL", DEFAULT_EDGE_URL))
    parser.add_argument("--include-database", action="store_true")
    parser.add_argument("--prompt-token", action="store_true", help="Prompt securely for an admin bearer token")
    parser.add_argument("--output-dir", type=Path, default=REPOSITORY_ROOT / "artifacts" / "baselines")
    args = parser.parse_args()

    token = os.getenv("BASELINE_BEARER_TOKEN", "")
    if args.prompt_token:
        token = getpass.getpass("Admin bearer token: ")
    snapshot = build_snapshot(
        render_url=args.render_url,
        edge_url=args.edge_url,
        bearer_token=token,
        include_database=args.include_database,
    )
    json_path, markdown_path = write_snapshot(snapshot, args.output_dir)
    print(f"Baseline JSON: {json_path}")
    print(f"Baseline Markdown: {markdown_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
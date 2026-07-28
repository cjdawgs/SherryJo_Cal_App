import os
import re
import logging
from datetime import datetime, timezone, timedelta
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app.database import DATABASE_URL, engine, get_db
from app.config import settings
from app.deps import require_admin
from app.models import OAuthAccount, TVDiagLog, User
from app.services.asset_urls import asset_url

router = APIRouter(prefix="/admin", tags=["admin"])
logger = logging.getLogger(__name__)

# Columns that must never leave the database through the table browser,
# whatever table they appear in: stored credentials and password hashes.
REDACTED_COLUMNS = frozenset(
    {
        "access_token",
        "refresh_token",
        "hashed_password",
        "password",
        "app_password",
        "sync_token",
        "google_access_token",
        "google_refresh_token",
        "ms_access_token",
        "ms_refresh_token",
    }
)

REDACTED_PLACEHOLDER = "***"

# The browser is a read-only inspection aid, not an export tool.
MAX_TABLE_ROWS = 200


def redact_row(row: dict) -> dict:
    return {
        key: (REDACTED_PLACEHOLDER if key in REDACTED_COLUMNS and value is not None else value)
        for key, value in row.items()
    }


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))
templates.env.globals.update(asset_url=asset_url)


def _safe_database_summary(url: str) -> dict:
    value = str(url or "")
    parsed = urlparse(value)

    if value.startswith("sqlite:///"):
        return {
            "engine": "sqlite",
            "label": "Local SQLite",
            "database": value.replace("sqlite:///", ""),
            "host": "local-file",
        }

    if value.startswith("postgresql"):
        return {
            "engine": "postgresql",
            "label": "PostgreSQL",
            "database": parsed.path.lstrip("/") or "postgres",
            "host": parsed.hostname or "unknown",
        }

    return {
        "engine": parsed.scheme or "unknown",
        "label": "Unknown",
        "database": parsed.path.lstrip("/") or "unknown",
        "host": parsed.hostname or "unknown",
    }


def _credential_encryption_health(db: Session, tables: list[str]) -> dict:
    token_key_configured = bool((getattr(settings, "token_encryption_key", None) or "").strip())
    encrypted_access_token_rows = 0

    if "oauth_accounts" in set(tables):
        try:
            encrypted_access_token_rows = int(
                db.execute(
                    text("SELECT COUNT(*) FROM oauth_accounts WHERE access_token LIKE 'v1:%'")
                ).scalar()
                or 0
            )
        except Exception as exc:
            logger.warning("Admin security overview query failed: %s", exc)

    encrypted_credentials_present = encrypted_access_token_rows > 0
    missing_key_with_encrypted_credentials = (
        encrypted_credentials_present and not token_key_configured
    )

    return {
        "token_encryption_key_configured": token_key_configured,
        "encrypted_access_token_rows": encrypted_access_token_rows,
        "encrypted_credentials_present": encrypted_credentials_present,
        "missing_key_with_encrypted_credentials": missing_key_with_encrypted_credentials,
    }


def _utc_day_bounds(now: datetime | None = None) -> tuple[datetime, datetime]:
    current = now or datetime.now(timezone.utc)
    start = current.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(days=1)


def _details_looks_like_failure(details: str | None) -> bool:
    value = str(details or "").lower()
    return any(flag in value for flag in ("status=error", "failed=1", "failed=2", "failed=3", "failed=4", "failed=5", "reason=no_targets", "warning"))


@router.get("/system/current-user-failures-today")
def admin_current_user_failures_today(
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    day_start, day_end = _utc_day_bounds()

    accounts = (
        db.query(OAuthAccount)
        .filter(OAuthAccount.user_id == admin_user.id)
        .order_by(OAuthAccount.id.asc())
        .all()
    )

    decrypt_warning_accounts = []
    sync_failure_accounts = []
    for account in accounts:
        token_value = str(getattr(account, "access_token_encrypted", "") or "")
        encrypted_at_rest = token_value.startswith("v1:")
        decrypt_error = encrypted_at_rest and not bool((getattr(settings, "token_encryption_key", None) or "").strip())

        if decrypt_error:
            decrypt_warning_accounts.append({
                "account_email": account.account_email,
                "provider": account.provider,
                "reason": "Encrypted credential exists but TOKEN_ENCRYPTION_KEY is not configured in this running app.",
            })

        failure_at = getattr(account, "last_sync_failure", None)
        if failure_at is not None and getattr(failure_at, "tzinfo", None) is None:
            failure_at = failure_at.replace(tzinfo=timezone.utc)
        if failure_at and day_start <= failure_at < day_end:
            sync_failure_accounts.append({
                "account_email": account.account_email,
                "provider": account.provider,
                "last_sync_failure": failure_at.isoformat(),
                "last_error": getattr(account, "last_error", None),
            })

    publish_rows = (
        db.query(TVDiagLog)
        .filter(
            TVDiagLog.user_id == admin_user.id,
            TVDiagLog.event == "calendar_publish_result",
            TVDiagLog.ts_server >= day_start,
            TVDiagLog.ts_server < day_end,
        )
        .order_by(TVDiagLog.ts_server.desc())
        .all()
    )

    publish_failures = [
        {
            "ts_server": row.ts_server.isoformat() if row.ts_server else None,
            "details": row.details,
        }
        for row in publish_rows
        if _details_looks_like_failure(row.details)
    ]

    checks_ran_on = _safe_database_summary(DATABASE_URL)
    has_failures = bool(decrypt_warning_accounts or sync_failure_accounts or publish_failures)
    summary_lines = []
    if decrypt_warning_accounts:
        summary_lines.append(
            f"{len(decrypt_warning_accounts)} account(s) cannot decrypt stored credentials in this runtime."
        )
    if sync_failure_accounts:
        summary_lines.append(
            f"{len(sync_failure_accounts)} account sync failure(s) were recorded today."
        )
    if publish_failures:
        summary_lines.append(
            f"{len(publish_failures)} publish failure or warning record(s) were logged today."
        )
    if not summary_lines:
        summary_lines.append("No decrypt warnings, sync failures, or publish failure diagnostics were recorded for this user today.")

    return {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "window": {
            "label": "today_utc",
            "start": day_start.isoformat(),
            "end": day_end.isoformat(),
        },
        "checked_database": checks_ran_on,
        "user": {
            "id": admin_user.id,
            "email": admin_user.email,
            "username": admin_user.username,
        },
        "has_failures": has_failures,
        "summary_lines": summary_lines,
        "counts": {
            "decrypt_warning_accounts": len(decrypt_warning_accounts),
            "sync_failures_today": len(sync_failure_accounts),
            "publish_failures_today": len(publish_failures),
            "publish_diagnostics_today": len(publish_rows),
        },
        "decrypt_warning_accounts": decrypt_warning_accounts,
        "sync_failure_accounts": sync_failure_accounts,
        "publish_failures": publish_failures,
    }


@router.get("/system/overview")
def admin_system_overview(
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    inspector = inspect(engine)
    tables = sorted(inspector.get_table_names())
    db_info = _safe_database_summary(DATABASE_URL)
    security_info = _credential_encryption_health(db, tables)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "database": db_info,
        "tables": tables,
        "table_count": len(tables),
        "admin_operations": {
            "users": [
                "List all users",
                "Create user login account",
                "Edit email, username, role",
                "Reset user password",
                "Delete user account",
            ],
            "providers": [
                "List all provider accounts",
                "Create provider account record",
                "Edit provider profile and status",
                "Activate/deactivate provider",
                "Delete provider account",
            ],
        },
        "security": security_info,
    }


@router.get("/system/table/{table_name}/rows")
def admin_table_rows(
    table_name: str,
    limit: int = MAX_TABLE_ROWS,
    offset: int = 0,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", table_name or ""):
        return {"table": table_name, "columns": [], "rows": [], "count": 0, "error": "Invalid table name"}

    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    if table_name not in existing_tables:
        return {"table": table_name, "columns": [], "rows": [], "count": 0, "error": "Table not found"}

    query = text(f'SELECT * FROM "{table_name}" LIMIT :limit OFFSET :offset')
    bounded_limit = max(1, min(limit, MAX_TABLE_ROWS))
    rows = db.execute(
        query, {"limit": bounded_limit, "offset": max(0, offset)}
    ).mappings().all()

    columns = (
        list(rows[0].keys())
        if rows
        else [col["name"] for col in inspector.get_columns(table_name)]
    )

    return {
        "table": table_name,
        "columns": columns,
        "redacted_columns": sorted(set(columns) & REDACTED_COLUMNS),
        "rows": [redact_row(dict(row)) for row in rows],
        "count": len(rows),
        "limit": bounded_limit,
        "offset": max(0, offset),
    }


@router.get("/ui")
def admin_dashboard_ui(
    request: Request,
):
    return templates.TemplateResponse(
        request,
        "admin.html",
        {"request": request}
    )


@router.get("")
def admin_root_redirect(
):
    return RedirectResponse(url="/admin/ui", status_code=307)

import os
import re
from datetime import datetime, timezone
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app.database import DATABASE_URL, engine, get_db
from app.deps import require_admin
from app.models import User
from app.services.asset_urls import asset_url

router = APIRouter(prefix="/admin", tags=["admin"])

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


@router.get("/system/overview")
def admin_system_overview(
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    inspector = inspect(engine)
    tables = sorted(inspector.get_table_names())
    db_info = _safe_database_summary(DATABASE_URL)

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

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

router = APIRouter(prefix="/admin", tags=["admin"])

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))


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
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", table_name or ""):
        return {"table": table_name, "columns": [], "rows": [], "count": 0, "error": "Invalid table name"}

    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    if table_name not in existing_tables:
        return {"table": table_name, "columns": [], "rows": [], "count": 0, "error": "Table not found"}

    query = text(f'SELECT * FROM "{table_name}"')
    rows = db.execute(query).mappings().all()

    return {
        "table": table_name,
        "columns": list(rows[0].keys()) if rows else [col["name"] for col in inspector.get_columns(table_name)],
        "rows": [dict(row) for row in rows],
        "count": len(rows),
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

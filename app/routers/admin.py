import os
import re
import json
import logging
import subprocess
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlparse
from urllib.error import HTTPError, URLError
from urllib.request import Request as UrlRequest, urlopen

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from sqlalchemy import inspect, text, create_engine
from sqlalchemy.engine import URL, make_url
from sqlalchemy.orm import Session, sessionmaker

import app.database as database_module
from app.database import Base, DATABASE_URL, engine, get_db
from app.config import is_production_environment, is_trusted_edge_request, mask_database_url, settings
from app.deps import require_admin
from app.models import OAuthAccount, TVDiagLog, TVUserState, User
from app.security import verify_password
from app.services.asset_urls import asset_url
from app.utils.crypto import TokenEncryptionError, reset_cipher_cache, unseal
from app.utils.runtime_token_key_store import persist_token_encryption_key

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
DEFAULT_GITHUB_REPOSITORY = "cjdawgs/SherryJo_Cal_App"
DEFAULT_GITHUB_BRANCH = "main"
DEFAULT_RENDER_DASHBOARD_URL = "https://dashboard.render.com/"
DEFAULT_CLOUDFLARE_DASHBOARD_URL = "https://dash.cloudflare.com/"
RENDER_DEPLOY_HOOK_ENV = "RENDER_DEPLOY_HOOK_URL"
CLOUDFLARE_DEPLOY_HOOK_ENV = "CLOUDFLARE_DEPLOY_HOOK_URL"
GIT_COMMIT_SCRIPT_ENV = "ADMIN_GIT_COMMIT_SCRIPT"


class RuntimeTokenEncryptionKeyUpdate(BaseModel):
    token_encryption_key: str


class GitCommitPushRequest(BaseModel):
    password: str


class TVRefreshRequest(BaseModel):
    device_id: str


class DatabaseRuntimeConfigUpdate(BaseModel):
    provider_title: str | None = None
    database_mode: str = "postgres"
    database_url: str | None = None
    database_user: str | None = None
    database_password: str | None = None
    database_host: str | None = None
    database_port: str | None = None
    database_name: str | None = None
    ssl_mode: str | None = None
    disable_sqlite_fallback: bool = True


class DatabaseCopyRequest(BaseModel):
    source_provider: str
    target_provider: str


CRITICAL_DATABASE_TABLES = (
    "users",
    "events",
    "tasks",
    "notes",
    "date_sticky_notes",
    "event_tag_color_settings",
)
OAUTH_ACCOUNT_COPY_COLUMNS = (
    "provider",
    "account_email",
    "access_token",
    "refresh_token",
    "token_expires_at",
    "display_name",
    "provider_id",
    "color",
    "is_primary",
    "sync_enabled",
    "status",
    "last_sync",
    "last_sync_success",
    "last_sync_failure",
    "last_error",
    "created_at",
    "updated_at",
)


def _database_profiles() -> list[dict]:
    try:
        profiles = json.loads(os.getenv("DB_PROFILES", "[]"))
    except (TypeError, ValueError):
        profiles = []
    return profiles if isinstance(profiles, list) else []


def _public_database_profiles(profiles: list[dict] | None = None) -> list[dict]:
    public_profiles = []
    for profile in profiles if profiles is not None else _database_profiles():
        database_url = str(profile.get("database_url") or "")
        summary = _safe_database_summary(database_url)
        try:
            parsed_url = make_url(database_url) if database_url else None
        except Exception:
            parsed_url = None
        public_profiles.append({
            "title": str(profile.get("title") or ""),
            "database_host": profile.get("database_host") or (parsed_url.host if parsed_url else None) or summary["host"],
            "database_port": profile.get("database_port") or (str(parsed_url.port) if parsed_url and parsed_url.port else "5432"),
            "database_name": profile.get("database_name") or (parsed_url.database if parsed_url else None) or summary["database"],
            "database_user": profile.get("database_user") or (parsed_url.username if parsed_url else None) or "",
            "ssl_mode": profile.get("ssl_mode") or (parsed_url.query.get("sslmode") if parsed_url else None) or "require",
            "provider": _database_provider_label(database_url),
            "has_saved_credentials": bool(profile.get("database_password") or database_url),
        })
    return public_profiles


def _database_runtime_mode(value: str | None) -> str:
    mode = (value or "").strip().lower()
    if mode in {"postgres", "postgresql"}:
        return "postgres"
    if mode in {"sqlite", "sqlite3"}:
        return "sqlite"
    if str(value or "").lower().startswith("sqlite"):
        return "sqlite"
    if str(value or "").lower().startswith("postgresql") or "postgres" in str(value or "").lower():
        return "postgres"
    return "postgres"


def _normalize_database_url(database_mode: str, candidate: str | None, database_user: str | None = None, database_password: str | None = None, database_host: str | None = None, database_name: str | None = None, ssl_mode: str | None = None, database_port: str | None = None) -> str:
    mode = (database_mode or "postgres").strip().lower()
    value = (candidate or "").strip()

    if mode == "sqlite":
        return value or "sqlite:///./app.db"

    if value:
        if value.startswith("postgres://"):
            value = f"postgresql://{value[len('postgres://'):]}"
        try:
            parsed_url = make_url(value)
        except Exception as exc:
            raise HTTPException(status_code=422, detail="The PostgreSQL connection string is invalid.") from exc
        if not parsed_url.drivername.startswith("postgresql"):
            raise HTTPException(status_code=422, detail="The connection string must use a PostgreSQL URL.")
        return value

    user = (database_user or "").strip()
    password = (database_password or "").strip()
    host = (database_host or "").strip()
    name = (database_name or "").strip()
    port_value = (database_port or "5432").strip()
    ssl_value = (ssl_mode or "require").strip().lower()

    if not (host and name):
        raise HTTPException(status_code=422, detail="Provide a Postgres host and database name or paste a complete Postgres URL.")

    if not user:
        raise HTTPException(status_code=422, detail="Provide a Postgres username for the datasource.")

    try:
        port = int(port_value)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="PostgreSQL port must be a number between 1 and 65535.") from exc
    if not 1 <= port <= 65535:
        raise HTTPException(status_code=422, detail="PostgreSQL port must be a number between 1 and 65535.")
    query = {} if ssl_value in {"off", "disable"} else {"sslmode": ssl_value}
    return URL.create(
        "postgresql",
        username=user,
        password=password or None,
        host=host,
        port=port,
        database=name,
        query=query,
    ).render_as_string(hide_password=False)


def _write_local_environment_values(replacements: dict[str, str]) -> Path:
    env_path = Path(BASE_DIR).parent / ".env"
    existing_lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []

    updated_lines = []
    seen_keys = set()

    for line in existing_lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            updated_lines.append(line)
            continue
        if "=" not in line:
            updated_lines.append(line)
            continue
        key, _ = line.split("=", 1)
        if key.strip() in replacements:
            updated_lines.append(f"{key.strip()}={_dotenv_storage_value(key.strip(), replacements[key.strip()])}")
            seen_keys.add(key.strip())
        else:
            updated_lines.append(line)

    for key, value in replacements.items():
        if key not in seen_keys:
            updated_lines.append(f"{key}={_dotenv_storage_value(key, value)}")

    env_path.write_text("\n".join(updated_lines) + "\n", encoding="utf-8")
    os.chmod(env_path, 0o600)
    return env_path


def _dotenv_quoted_value(value: str) -> str:
    escaped = str(value).replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"


def _dotenv_storage_value(key: str, value: str) -> str:
    if key == "DB_PROFILES":
        value = value.replace("$", r"\u0024")
    return _dotenv_quoted_value(value)


def _persist_database_profile(provider_title: str, database_url: str, connection_fields: dict) -> dict:
    if is_production_environment():
        raise HTTPException(
            status_code=409,
            detail="This hosted origin uses provider-managed environment secrets. Save database profiles in local development or manage the hosted database through its provider.",
        )
    title = provider_title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="Enter a provider title before saving this profile.")

    profiles = [profile for profile in _database_profiles() if profile.get("title") != title]
    profile = {
        "title": title,
        "database_url": database_url,
        "database_user": connection_fields["database_user"] or "",
        "database_password": connection_fields["database_password"] or "",
        "database_host": connection_fields["database_host"] or "",
        "database_port": connection_fields["database_port"] or "5432",
        "database_name": connection_fields["database_name"] or "",
        "ssl_mode": connection_fields["ssl_mode"] or "require",
    }
    profiles.append(profile)
    profiles_json = json.dumps(profiles, separators=(",", ":"))
    _write_local_environment_values({"DB_PROFILES": profiles_json})
    os.environ["DB_PROFILES"] = profiles_json
    return _public_database_profiles([profile])[0]


def _persist_runtime_database_config(database_url: str, database_mode: str, disable_sqlite_fallback: bool, provider_title: str | None = None, database_user: str | None = None, database_password: str | None = None, database_host: str | None = None, database_name: str | None = None, ssl_mode: str | None = None, database_port: str | None = None) -> dict:
    if is_production_environment():
        raise HTTPException(
            status_code=409,
            detail="This hosted origin uses provider-managed environment secrets. Update its database settings in the hosting provider, or use the Cloudflare Hyperdrive controls.",
        )

    replacements = {
        "DATABASE_URL": database_url,
        "REQUIRE_DB_KIND": database_mode,
        "DISABLE_SQLITE_FALLBACK": "1" if disable_sqlite_fallback else "0",
        "DB_TYPE": database_mode,
        "DB_USER": database_user or "",
        "DB_PASSWORD": database_password or "",
        "DB_HOST": database_host or "",
        "DB_NAME": database_name or "",
        "DB_PORT": database_port or "5432",
        "DB_SSL_MODE": (ssl_mode or "require").strip() or "require",
    }
    profiles = [profile for profile in _database_profiles() if profile.get("title") != (provider_title or "").strip()]
    if provider_title and database_mode == "postgres":
        profiles.append({
            "title": provider_title.strip(),
            "database_url": database_url,
            "database_user": database_user or "",
            "database_password": database_password or "",
            "database_host": database_host or "",
            "database_port": database_port or "5432",
            "database_name": database_name or "",
            "ssl_mode": (ssl_mode or "require").strip() or "require",
        })
        replacements["DB_PROFILES"] = json.dumps(profiles, separators=(",", ":"))

    _write_local_environment_values(replacements)

    os.environ["DATABASE_URL"] = database_url
    os.environ["REQUIRE_DB_KIND"] = database_mode
    os.environ["DISABLE_SQLITE_FALLBACK"] = "1" if disable_sqlite_fallback else "0"
    os.environ["DB_TYPE"] = database_mode
    os.environ["DB_USER"] = database_user or ""
    os.environ["DB_PASSWORD"] = database_password or ""
    os.environ["DB_HOST"] = database_host or ""
    os.environ["DB_NAME"] = database_name or ""
    os.environ["DB_PORT"] = database_port or "5432"
    os.environ["DB_SSL_MODE"] = (ssl_mode or "require").strip() or "require"
    if "DB_PROFILES" in replacements:
        os.environ["DB_PROFILES"] = replacements["DB_PROFILES"]

    return {
        "provider_title": provider_title,
        "database_mode": database_mode,
        "disable_sqlite_fallback": disable_sqlite_fallback,
        "database_user": database_user,
        "database_host": database_host,
        "database_name": database_name,
        "ssl_mode": (ssl_mode or "require").strip() or "require",
        "profiles": _public_database_profiles(profiles),
        "persistence": "local dotenv",
    }


def _test_database_url(database_url: str) -> dict:
    test_engine = None
    try:
        if database_url.startswith("sqlite"):
            test_engine = create_engine(database_url, connect_args={"check_same_thread": False})
        else:
            parsed_url = make_url(database_url)
            connect_args = {"connect_timeout": 5}
            if parsed_url.drivername.startswith("postgresql"):
                ssl_mode = parsed_url.query.get("sslmode", "require")
                connect_args["sslmode"] = ssl_mode
            test_engine = create_engine(database_url, pool_pre_ping=True, connect_args=connect_args)
        with test_engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return {"ok": True, "message": "Database connection verified."}
    except Exception as exc:
        logger.warning("Database connection test failed for %s (%s)", mask_database_url(database_url), type(exc).__name__)
        return {"ok": False, "message": "Connection failed. Verify the host, port, database name, username, password, and SSL mode."}
    finally:
        if test_engine is not None:
            test_engine.dispose()


def _active_database_connection_status() -> dict:
    try:
        with database_module.engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return {"connected": True, "message": "Active database connection verified."}
    except Exception as exc:
        logger.warning("Active database connection check failed (%s)", type(exc).__name__)
        return {"connected": False, "message": "The active database is not reachable from this app runtime."}


def _resolve_database_config(payload: DatabaseRuntimeConfigUpdate) -> tuple[str, dict]:
    profile = next(
        (item for item in _database_profiles() if item.get("title") == (payload.provider_title or "").strip()),
        None,
    )
    profile = profile or {}
    database_user = payload.database_user or profile.get("database_user")
    database_password = payload.database_password or profile.get("database_password")
    database_host = payload.database_host or profile.get("database_host")
    database_name = payload.database_name or profile.get("database_name")
    database_port = payload.database_port or profile.get("database_port") or "5432"
    ssl_mode = payload.ssl_mode or profile.get("ssl_mode") or "require"
    database_url = payload.database_url

    if payload.database_mode == "postgres" and not (database_url or "").strip():
        if profile.get("database_url"):
            try:
                saved_url = make_url(str(profile["database_url"]))
            except Exception as exc:
                raise HTTPException(
                    status_code=422,
                    detail="The saved provider profile is invalid. Re-enter its connection details and test it again.",
                ) from exc
            saved_host = profile.get("database_host") or saved_url.host
            saved_user = profile.get("database_user") or saved_url.username
            saved_name = profile.get("database_name") or saved_url.database
            saved_port = str(profile.get("database_port") or saved_url.port or "5432")
            saved_ssl_mode = profile.get("ssl_mode") or saved_url.query.get("sslmode") or "require"
            fields_match_saved_profile = (
                database_host == saved_host
                and database_user == saved_user
                and database_name == saved_name
                and str(database_port) == str(saved_port)
                and ssl_mode == saved_ssl_mode
            )
            if fields_match_saved_profile:
                database_url = saved_url.set(
                    password=database_password or saved_url.password
                ).render_as_string(hide_password=False)
        if not (database_host and database_name and database_user):
            database_url = database_url or profile.get("database_url")

    normalized_url = _normalize_database_url(
        payload.database_mode,
        database_url,
        database_user,
        database_password,
        database_host,
        database_name,
        ssl_mode,
        database_port,
    )
    if (payload.database_url or "").strip():
        parsed_url = make_url(normalized_url)
        database_user = parsed_url.username or database_user
        database_password = parsed_url.password or database_password
        database_host = parsed_url.host or database_host
        database_name = parsed_url.database or database_name
        database_port = str(parsed_url.port or database_port or "5432")
        ssl_mode = parsed_url.query.get("sslmode", ssl_mode or "require")
    return normalized_url, {
        "database_user": database_user,
        "database_password": database_password,
        "database_host": database_host,
        "database_name": database_name,
        "database_port": database_port,
        "ssl_mode": ssl_mode,
    }


def _create_connected_database_engine(database_url: str):
    if database_url.startswith("sqlite"):
        connect_args = {"check_same_thread": False}
    else:
        parsed_url = make_url(database_url)
        connect_args = {"connect_timeout": 5}
        if parsed_url.drivername.startswith("postgresql"):
            connect_args["sslmode"] = parsed_url.query.get("sslmode", "require")
    replacement_engine = create_engine(database_url, pool_pre_ping=True, connect_args=connect_args)
    try:
        with replacement_engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        replacement_engine.dispose()
        raise
    return replacement_engine


def _copy_critical_database_data(source_url: str, target_url: str) -> dict:
    source_engine = create_engine(source_url, pool_pre_ping=True)
    target_engine = create_engine(target_url, pool_pre_ping=True)
    copied = {}
    try:
        with source_engine.connect() as source, target_engine.begin() as target:
            target_inspector = inspect(target_engine)

            def finalize_copy() -> dict:
                copied["sequences"] = {
                    "reset": _reset_postgres_sequences(
                        target,
                        target_inspector,
                        (*CRITICAL_DATABASE_TABLES, "oauth_accounts"),
                    )
                }
                return copied

            for table in CRITICAL_DATABASE_TABLES:
                source_inspector = inspect(source_engine)
                if table not in source_inspector.get_table_names() or table not in target_inspector.get_table_names():
                    copied[table] = {"copied": 0, "skipped": "table missing"}
                    continue
                source_columns = [column["name"] for column in source_inspector.get_columns(table)]
                target_columns = {column["name"] for column in target_inspector.get_columns(table)}
                columns = [column for column in source_columns if column in target_columns]
                if not columns:
                    copied[table] = {"copied": 0, "skipped": "no shared columns"}
                    continue
                rows = source.execute(text(f'SELECT {", ".join(f"{column}" for column in columns)} FROM "{table}"')).mappings().all()
                if not rows:
                    copied[table] = {"copied": 0, "skipped": "empty"}
                    continue
                column_sql = ", ".join(f'"{column}"' for column in columns)
                values_sql = ", ".join(f":value_{index}" for index in range(len(columns)))
                insert_sql = text(f'INSERT INTO "{table}" ({column_sql}) VALUES ({values_sql}) ON CONFLICT DO NOTHING')
                inserted = 0
                for row in rows:
                    result = target.execute(insert_sql, {f"value_{index}": row[column] for index, column in enumerate(columns)})
                    inserted += result.rowcount or 0
                copied[table] = {"copied": inserted, "examined": len(rows)}
            if "oauth_accounts" not in source_inspector.get_table_names() or "oauth_accounts" not in target_inspector.get_table_names():
                copied["oauth_accounts"] = {"copied": 0, "examined": 0, "skipped": "table missing"}
                return finalize_copy()
            source_users = source.execute(text('SELECT id, email FROM "users"')).mappings().all()
            target_users = target.execute(text('SELECT id, email FROM "users"')).mappings().all()
            source_account_columns = {column["name"] for column in source_inspector.get_columns("oauth_accounts")}
            target_account_columns = {column["name"] for column in target_inspector.get_columns("oauth_accounts")}
            account_columns = [column for column in OAUTH_ACCOUNT_COPY_COLUMNS if column in source_account_columns and column in target_account_columns]
            if not account_columns:
                copied["oauth_accounts"] = {"copied": 0, "examined": 0, "skipped": "no shared columns"}
                return finalize_copy()
            target_user_ids = {str(row["email"]).strip().lower(): row["id"] for row in target_users if row.get("email")}
            provider_rows = source.execute(text(f'SELECT user_id, {", ".join(account_columns)} FROM "oauth_accounts"')).mappings().all()
            inserted_accounts = 0
            skipped_accounts = 0
            for row in provider_rows:
                source_user = next((user for user in source_users if user["id"] == row["user_id"]), None)
                destination_user_id = target_user_ids.get(str(source_user["email"]).strip().lower()) if source_user else None
                if not destination_user_id:
                    skipped_accounts += 1
                    continue
                values = {column: row[column] for column in account_columns}
                values["user_id"] = destination_user_id
                columns = ["user_id", *account_columns]
                column_sql = ", ".join(f'"{column}"' for column in columns)
                values_sql = ", ".join(f":account_{index}" for index in range(len(columns)))
                result = target.execute(text(f'INSERT INTO "oauth_accounts" ({column_sql}) VALUES ({values_sql}) ON CONFLICT DO NOTHING'), {f"account_{index}": values[column] for index, column in enumerate(columns)})
                inserted_accounts += result.rowcount or 0
            copied["oauth_accounts"] = {"copied": inserted_accounts, "examined": len(provider_rows), "skipped": skipped_accounts}
            finalize_copy()
    finally:
        source_engine.dispose()
        target_engine.dispose()
    return copied


def _reset_postgres_sequences(connection, inspector, tables: tuple[str, ...]) -> int:
    reset_count = 0
    existing_tables = set(inspector.get_table_names())
    for table in tables:
        if table not in existing_tables:
            continue
        for column in inspector.get_pk_constraint(table).get("constrained_columns", []):
            sequence = connection.execute(
                text("SELECT pg_get_serial_sequence(:table_name, :column_name)"),
                {"table_name": table, "column_name": column},
            ).scalar()
            if not sequence:
                continue
            quoted_column = column.replace('"', '""')
            quoted_table = table.replace('"', '""')
            maximum = connection.execute(
                text(f'SELECT MAX("{quoted_column}") FROM "{quoted_table}"')
            ).scalar()
            connection.execute(
                text("SELECT setval(CAST(:sequence AS regclass), :value, :is_called)"),
                {
                    "sequence": sequence,
                    "value": maximum if maximum is not None else 1,
                    "is_called": maximum is not None,
                },
            )
            reset_count += 1
    return reset_count


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
        hostname = (parsed.hostname or "unknown").lower()
        if "supabase" in hostname:
            label = "Supabase Postgres"
        elif "neon" in hostname:
            label = "Neon Postgres"
        else:
            label = "PostgreSQL"
        return {
            "engine": "postgresql",
            "label": label,
            "database": parsed.path.lstrip("/") or "postgres",
            "host": parsed.hostname or "unknown",
        }

    return {
        "engine": parsed.scheme or "unknown",
        "label": "Unknown",
        "database": parsed.path.lstrip("/") or "unknown",
        "host": parsed.hostname or "unknown",
    }


def _preferred_postgres_url() -> str | None:
    for env_name in (
        "SUPABASE_URL",
        "SUPABASE_DATABASE_URL",
        "NEON_DATABASE_URL",
        "POSTGRES_URL",
        "POSTGRES_DATABASE_URL",
        "DATABASE_URL",
    ):
        value = str(os.getenv(env_name) or "").strip()
        if value.startswith(("postgresql://", "postgresql+psycopg2://", "postgresql+psycopg2cffi://")):
            return value
    return None


def _database_provider_label(url: str | None) -> str:
    value = str(url or "").strip()
    if not value:
        return "not-configured"
    hostname = urlparse(value).hostname or ""
    lowered = hostname.lower()
    if "supabase" in lowered:
        return "supabase"
    if "neon" in lowered:
        return "neon"
    if value.startswith("sqlite"):
        return "sqlite"
    return "postgres"


def _configured_database_provider(url: str | None) -> str:
    configured = str(os.getenv("DATABASE_PROVIDER") or "").strip().lower()
    if configured in {"neon", "supabase"}:
        return configured
    return _database_provider_label(url)


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


def _parse_iso_date_or_422(raw_value: str, field_name: str) -> datetime:
    try:
        return datetime.fromisoformat(f"{str(raw_value).strip()}T00:00:00+00:00")
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"{field_name} must be YYYY-MM-DD.") from exc


def _normalize_git_sha(value: str | None) -> str | None:
    candidate = str(value or "").strip().lower()
    if re.fullmatch(r"[0-9a-f]{7,40}", candidate):
        return candidate
    return None


def _current_deployment_commit() -> tuple[str | None, str]:
    for env_name in ("RENDER_GIT_COMMIT", "APP_VERSION", "SOURCE_VERSION", "RENDER_COMMIT_SHA", "GITHUB_SHA"):
        candidate = _normalize_git_sha(os.getenv(env_name))
        if candidate:
            return candidate, env_name
    return None, "unknown"


def _github_repo_settings() -> tuple[str, str]:
    repo = str(os.getenv("GITHUB_REPOSITORY", DEFAULT_GITHUB_REPOSITORY) or DEFAULT_GITHUB_REPOSITORY).strip()
    branch = str(os.getenv("GITHUB_BRANCH", DEFAULT_GITHUB_BRANCH) or DEFAULT_GITHUB_BRANCH).strip() or DEFAULT_GITHUB_BRANCH
    return repo, branch


def _github_repo_urls(repo: str, branch: str) -> dict:
    base = f"https://github.com/{repo}"
    return {
        "repository_url": base,
        "branch_url": f"{base}/commits/{branch}",
        "compare_base_url": f"{base}/compare",
    }


def _fetch_github_latest_commit_probe(repo: str, branch: str) -> dict:
    url = f"https://api.github.com/repos/{repo}/commits/{branch}"
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "SherryJo-Cal-App",
    }
    token = str(os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN") or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    request = UrlRequest(url, headers=headers, method="GET")
    try:
        with urlopen(request, timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8"))
            status_code = getattr(response, "status", None) or response.getcode() or 200
        commit = _normalize_git_sha(payload.get("sha"))
        return {
            "commit": commit,
            "error": None if commit else "GitHub API returned a response but no commit SHA.",
            "error_code": None if commit else "missing_sha",
            "http_status": status_code,
        }
    except HTTPError as exc:
        error_code = "rate_limited" if int(getattr(exc, "code", 0) or 0) == 403 else "http_error"
        detail = f"GitHub API HTTP {getattr(exc, 'code', 'error')}"
        logger.warning("Deployment sync GitHub lookup failed: %s", exc)
        return {"commit": None, "error": detail, "error_code": error_code, "http_status": getattr(exc, "code", None)}
    except URLError as exc:
        logger.warning("Deployment sync GitHub lookup failed: %s", exc)
        return {"commit": None, "error": f"Network error contacting GitHub: {exc.reason}", "error_code": "network_error", "http_status": None}
    except TimeoutError as exc:
        logger.warning("Deployment sync GitHub lookup failed: %s", exc)
        return {"commit": None, "error": "Timed out contacting GitHub.", "error_code": "timeout", "http_status": None}
    except (ValueError, json.JSONDecodeError) as exc:
        logger.warning("Deployment sync GitHub lookup failed: %s", exc)
        return {"commit": None, "error": "GitHub API response could not be parsed.", "error_code": "invalid_response", "http_status": None}
    except Exception as exc:
        logger.warning("Deployment sync GitHub lookup failed: %s", exc)
        return {"commit": None, "error": f"Unexpected GitHub verification error: {exc}", "error_code": "unexpected_error", "http_status": None}


def _render_dashboard_url() -> str:
    return str(os.getenv("RENDER_DASHBOARD_URL", DEFAULT_RENDER_DASHBOARD_URL) or DEFAULT_RENDER_DASHBOARD_URL).strip()


def _render_deploy_hook_url() -> str | None:
    value = str(os.getenv(RENDER_DEPLOY_HOOK_ENV, "") or "").strip()
    return value or None


def _cloudflare_dashboard_url() -> str:
    return str(os.getenv("CLOUDFLARE_DASHBOARD_URL", DEFAULT_CLOUDFLARE_DASHBOARD_URL) or DEFAULT_CLOUDFLARE_DASHBOARD_URL).strip()


def _cloudflare_deploy_hook_url() -> str | None:
    value = str(os.getenv(CLOUDFLARE_DEPLOY_HOOK_ENV, "") or "").strip()
    return value or None


def _active_deployment_platform(request: Request | None) -> str:
    if is_trusted_edge_request(request):
        return "cloudflare"
    return "render"


def _git_commit_script_path() -> Path | None:
    configured = str(os.getenv(GIT_COMMIT_SCRIPT_ENV, "") or "").strip()
    candidates = []
    if configured:
        candidates.append(Path(configured).expanduser())
    candidates.append(Path(BASE_DIR).parents[2] / "Commit_SherryJo_Cal_App.ps1")

    for path in candidates:
        candidate = path.resolve()
        if candidate.suffix.lower() == ".ps1" and candidate.is_file():
            return candidate
    return None


def _repository_controls_payload() -> dict:
    script_path = _git_commit_script_path()
    available = script_path is not None and os.name == "nt"
    return {
        "commit_push_available": available,
        "commit_push_endpoint": "/admin/system/github/commit-push" if available else None,
        "commit_push_requires_password": True,
        "commit_push_hint": (
            "Launch the approved PowerShell commit workflow on this desktop."
            if available
            else f"Set {GIT_COMMIT_SCRIPT_ENV} to the approved .ps1 path on a Windows desktop to enable this action."
        ),
        "fetch_pull_targets": [
            {"id": "desktop", "label": "Local desktop", "status": "planned", "available": False},
            {"id": "codespace", "label": "GitHub Codespace", "status": "planned", "available": False},
        ],
    }


def _deployment_sync_payload(request: Request | None = None) -> dict:
    current_commit, current_commit_source = _current_deployment_commit()
    github_repo, github_branch = _github_repo_settings()
    github_probe = _fetch_github_latest_commit_probe(github_repo, github_branch)
    github_latest_commit = github_probe.get("commit")
    dashboard_url = _render_dashboard_url()
    deploy_hook_url = _render_deploy_hook_url()
    cloudflare_deploy_hook_url = _cloudflare_deploy_hook_url()
    github_urls = _github_repo_urls(github_repo, github_branch)
    active_platform = _active_deployment_platform(request)

    if current_commit and github_latest_commit:
        status = "synced" if current_commit == github_latest_commit else "out_of_sync"
    elif current_commit or github_latest_commit:
        status = "unknown"
    else:
        status = "unknown"

    if status == "synced":
        message = f"{('Cloudflare edge / Render origin' if active_platform == 'cloudflare' else 'Render deployment')} matches the latest GitHub commit."
    elif status == "out_of_sync":
        message = f"{('Cloudflare edge / Render origin' if active_platform == 'cloudflare' else 'Render deployment')} is not on the latest GitHub commit yet."
    else:
        message = "Unable to verify deployment sync from the running app."

    compare_url = None
    current_commit_url = None
    latest_commit_url = None
    if current_commit:
        current_commit_url = f"{github_urls['repository_url']}/commit/{current_commit}"
    if github_latest_commit:
        latest_commit_url = f"{github_urls['repository_url']}/commit/{github_latest_commit}"
    if current_commit and github_latest_commit and current_commit != github_latest_commit:
        compare_url = f"{github_urls['compare_base_url']}/{current_commit}...{github_latest_commit}"

    return {
        "repository": github_repo,
        "branch": github_branch,
        "current_commit": current_commit,
        "current_commit_source": current_commit_source,
        "github_latest_commit": github_latest_commit,
        "github_error": github_probe.get("error"),
        "github_error_code": github_probe.get("error_code"),
        "github_http_status": github_probe.get("http_status"),
        "status": status,
        "message": message,
        "active_platform": active_platform,
        "active_platform_label": "Cloudflare edge / Render origin" if active_platform == "cloudflare" else "Render origin",
        "platforms": [
            {
                "id": "render",
                "label": "Render origin",
                "role": "Application origin",
                "dashboard_url": dashboard_url,
                "manual_deploy_available": bool(deploy_hook_url),
                "manual_deploy_endpoint": "/admin/system/render/redeploy" if deploy_hook_url else None,
            },
            {
                "id": "cloudflare",
                "label": "Cloudflare edge",
                "role": "Public edge proxy",
                "dashboard_url": _cloudflare_dashboard_url(),
                "manual_deploy_available": bool(cloudflare_deploy_hook_url),
                "manual_deploy_endpoint": "/admin/system/cloudflare/redeploy" if cloudflare_deploy_hook_url else None,
            },
        ],
        "render_dashboard_url": dashboard_url,
        **github_urls,
        "current_commit_url": current_commit_url,
        "latest_commit_url": latest_commit_url,
        "compare_url": compare_url,
        "manual_deploy_available": bool(deploy_hook_url),
        "manual_deploy_endpoint": "/admin/system/render/redeploy" if deploy_hook_url else None,
        "manual_deploy_hint": "Trigger the Render deploy hook from this admin app." if deploy_hook_url else "Open the Render dashboard and trigger a manual deploy there.",
        "repository_controls": _repository_controls_payload(),
    }


def _trigger_render_deploy_hook() -> dict:
    deploy_hook_url = _render_deploy_hook_url()
    if not deploy_hook_url:
        raise HTTPException(status_code=400, detail="RENDER_DEPLOY_HOOK_URL is not configured.")

    request = UrlRequest(deploy_hook_url, data=b"", method="POST")
    try:
        with urlopen(request, timeout=10) as response:
            body = response.read().decode("utf-8", errors="ignore").strip()
            status_code = getattr(response, "status", None) or response.getcode() or 200
        return {
            "triggered": True,
            "status_code": status_code,
            "message": "Render deploy hook triggered.",
            "response": body[:500] if body else "",
            "render_dashboard_url": _render_dashboard_url(),
        }
    except (HTTPError, URLError, TimeoutError) as exc:
        logger.warning("Render deploy hook failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"Failed to trigger Render deploy hook: {exc}") from exc
    except Exception as exc:
        logger.warning("Render deploy hook failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"Failed to trigger Render deploy hook: {exc}") from exc


def _trigger_cloudflare_deploy_hook() -> dict:
    deploy_hook_url = _cloudflare_deploy_hook_url()
    if not deploy_hook_url:
        raise HTTPException(status_code=400, detail=f"{CLOUDFLARE_DEPLOY_HOOK_ENV} is not configured.")

    request = UrlRequest(deploy_hook_url, data=b"", method="POST")
    try:
        with urlopen(request, timeout=10) as response:
            body = response.read().decode("utf-8", errors="ignore").strip()
            status_code = getattr(response, "status", None) or response.getcode() or 200
        return {
            "triggered": True,
            "status_code": status_code,
            "message": "Cloudflare deploy hook triggered.",
            "response": body[:500] if body else "",
            "cloudflare_dashboard_url": _cloudflare_dashboard_url(),
        }
    except (HTTPError, URLError, TimeoutError) as exc:
        logger.warning("Cloudflare deploy hook failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"Failed to trigger Cloudflare deploy hook: {exc}") from exc
    except Exception as exc:
        logger.warning("Cloudflare deploy hook failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"Failed to trigger Cloudflare deploy hook: {exc}") from exc


def _launch_git_commit_script() -> dict:
    script_path = _git_commit_script_path()
    if script_path is None or os.name != "nt":
        raise HTTPException(status_code=409, detail="The approved desktop commit script is not available in this runtime.")

    try:
        subprocess.Popen(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script_path)],
            cwd=str(script_path.parent),
            creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
        )
    except OSError as exc:
        logger.warning("Approved Git commit script launch failed: %s", exc)
        raise HTTPException(status_code=500, detail="Unable to launch the approved Git commit workflow.") from exc

    return {"launched": True, "message": "Approved commit and push workflow opened in PowerShell."}


def _extract_publish_reason(details: str | None) -> str:
    value = str(details or "")
    match = re.search(r"reason=([^\s]+)", value)
    if match:
        return match.group(1)
    if "warning" in value.lower():
        return "warning"
    if "status=error" in value.lower():
        return "error"
    return "unknown"


def _apply_runtime_token_encryption_key(candidate_key: str, db: Session) -> dict:
    previous_key = getattr(settings, "token_encryption_key", None)
    previous_env = os.getenv("TOKEN_ENCRYPTION_KEY")
    normalized = str(candidate_key or "").strip()
    if not normalized:
        raise HTTPException(status_code=422, detail="TOKEN_ENCRYPTION_KEY is required.")

    probe_value = db.execute(
        text("SELECT access_token FROM oauth_accounts WHERE access_token LIKE 'v1:%' LIMIT 1")
    ).scalar()

    try:
        os.environ["TOKEN_ENCRYPTION_KEY"] = normalized
        settings.token_encryption_key = normalized
        reset_cipher_cache()

        if probe_value:
            unseal(str(probe_value))

        persist_token_encryption_key(db, normalized)
        db.commit()

        tables = sorted(inspect(engine).get_table_names())
        security_info = _credential_encryption_health(db, tables)
        return {
            "resolved": not bool(security_info.get("missing_key_with_encrypted_credentials")),
            "security": security_info,
            "message": "TOKEN_ENCRYPTION_KEY applied and saved for automatic restart bootstrap.",
            "persists_after_restart": True,
        }
    except (TokenEncryptionError, HTTPException) as exc:
        db.rollback()
        if previous_env is None:
            os.environ.pop("TOKEN_ENCRYPTION_KEY", None)
        else:
            os.environ["TOKEN_ENCRYPTION_KEY"] = previous_env
        settings.token_encryption_key = previous_key
        reset_cipher_cache()
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        db.rollback()
        if previous_env is None:
            os.environ.pop("TOKEN_ENCRYPTION_KEY", None)
        else:
            os.environ["TOKEN_ENCRYPTION_KEY"] = previous_env
        settings.token_encryption_key = previous_key
        reset_cipher_cache()
        raise HTTPException(status_code=500, detail=f"Failed to persist runtime encryption key: {exc}") from exc


@router.post("/system/token-encryption-key/runtime")
def admin_apply_runtime_token_encryption_key(
    payload: RuntimeTokenEncryptionKeyUpdate,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    return _apply_runtime_token_encryption_key(payload.token_encryption_key, db)


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


@router.get("/system/current-user-failure-history")
def admin_current_user_failure_history(
    start_date: str,
    end_date: str,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    window_start = _parse_iso_date_or_422(start_date, "start_date")
    window_end = _parse_iso_date_or_422(end_date, "end_date") + timedelta(days=1)
    if window_end <= window_start:
        raise HTTPException(status_code=422, detail="end_date must be on or after start_date.")
    if window_end - window_start > timedelta(days=90):
        raise HTTPException(status_code=422, detail="Date range cannot exceed 90 days.")

    accounts = (
        db.query(OAuthAccount)
        .filter(OAuthAccount.user_id == admin_user.id)
        .order_by(OAuthAccount.id.asc())
        .all()
    )

    sync_failure_accounts = []
    for account in accounts:
        failure_at = getattr(account, "last_sync_failure", None)
        if failure_at is not None and getattr(failure_at, "tzinfo", None) is None:
            failure_at = failure_at.replace(tzinfo=timezone.utc)
        if failure_at and window_start <= failure_at < window_end:
            sync_failure_accounts.append({
                "provider": account.provider,
                "account_email": account.account_email,
                "last_sync_failure": failure_at.isoformat(),
                "last_error": getattr(account, "last_error", None),
            })

    publish_rows = (
        db.query(TVDiagLog)
        .filter(
            TVDiagLog.user_id == admin_user.id,
            TVDiagLog.event == "calendar_publish_result",
            TVDiagLog.ts_server >= window_start,
            TVDiagLog.ts_server < window_end,
        )
        .order_by(TVDiagLog.ts_server.desc())
        .all()
    )

    publish_failures = []
    publish_reasons: dict[str, int] = {}
    for row in publish_rows:
        if not _details_looks_like_failure(row.details):
            continue
        reason = _extract_publish_reason(row.details)
        publish_reasons[reason] = publish_reasons.get(reason, 0) + 1
        publish_failures.append({
            "ts_server": row.ts_server.isoformat() if row.ts_server else None,
            "details": row.details,
            "reason": reason,
        })

    recent_error_messages = []
    seen_errors = set()
    for account in sync_failure_accounts:
        message = str(account.get("last_error") or "").strip()
        if not message or message in seen_errors:
            continue
        seen_errors.add(message)
        recent_error_messages.append(message)

    meaningful_points = [
        f"Checked {len(sync_failure_accounts)} account-level sync failure signal(s) whose latest recorded failure falls inside this date range.",
        f"Found {len(publish_failures)} publish failure/warning diagnostic row(s) across {len(publish_reasons)} distinct publish failure reason(s).",
        f"This report uses persisted diagnostics only; decrypt warnings are live-state only and are not backfilled historically unless another persisted signal captured them.",
    ]

    return {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "window": {
            "start": window_start.isoformat(),
            "end": window_end.isoformat(),
            "start_date": start_date,
            "end_date": end_date,
        },
        "checked_database": _safe_database_summary(DATABASE_URL),
        "user": {
            "id": admin_user.id,
            "email": admin_user.email,
            "username": admin_user.username,
        },
        "counts": {
            "sync_failures": len(sync_failure_accounts),
            "publish_failure_rows": len(publish_failures),
            "distinct_publish_failure_reasons": len(publish_reasons),
            "total_publish_diagnostics": len(publish_rows),
        },
        "meaningful_points": meaningful_points,
        "sync_failure_accounts": sync_failure_accounts,
        "publish_failure_reasons": [
            {"reason": reason, "count": count}
            for reason, count in sorted(publish_reasons.items(), key=lambda item: (-item[1], item[0]))
        ],
        "publish_failures": publish_failures[:25],
        "recent_error_messages": recent_error_messages[:10],
    }


@router.get("/system/tv-stale-refresh-summary")
def admin_tv_stale_refresh_summary(
    hours: int = 24,
    limit: int = 50,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    bounded_hours = max(1, min(int(hours or 24), 24 * 14))
    bounded_limit = max(1, min(int(limit or 50), 200))

    now_utc = datetime.now(timezone.utc)
    window_start = now_utc - timedelta(hours=bounded_hours)

    rows = (
        db.query(TVDiagLog)
        .filter(
            TVDiagLog.event == "stale_snapshot_used",
            TVDiagLog.ts_server >= window_start,
        )
        .order_by(TVDiagLog.ts_server.desc())
        .limit(bounded_limit)
        .all()
    )

    reason_counts: dict[str, int] = {}
    user_ids = set()
    device_ids = set()
    recent_rows = []

    for row in rows:
        reason = str(row.details or "").strip() or "unknown"
        reason_counts[reason] = reason_counts.get(reason, 0) + 1
        if row.user_id is not None:
            user_ids.add(row.user_id)
        if row.device_id:
            device_ids.add(row.device_id)

        recent_rows.append({
            "ts_server": row.ts_server.isoformat() if row.ts_server else None,
            "user_id": row.user_id,
            "device_id": row.device_id,
            "reason": reason,
            "elapsed_min": row.elapsed_min,
            "visibility": row.visibility,
        })

    return {
        "checked_at": now_utc.isoformat(),
        "checked_database": _safe_database_summary(DATABASE_URL),
        "window": {
            "hours": bounded_hours,
            "start": window_start.isoformat(),
            "end": now_utc.isoformat(),
        },
        "counts": {
            "stale_snapshot_events": len(rows),
            "unique_users": len(user_ids),
            "unique_devices": len(device_ids),
        },
        "reason_counts": [
            {"reason": reason, "count": count}
            for reason, count in sorted(reason_counts.items(), key=lambda item: (-item[1], item[0]))
        ],
        "meaningful_points": [
            "These entries are recorded only when the TV UI keeps the last known event snapshot instead of clearing visible events during a refresh issue.",
            "A higher count here means the safety guard prevented potential blank-board incidents.",
            "Use Live Diagnostics Log above to correlate exact lifecycle events around each stale snapshot fallback.",
        ],
        "recent_rows": recent_rows,
    }


@router.post("/system/tv-refresh-request")
def admin_tv_refresh_request(
    payload: TVRefreshRequest,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    device_id = payload.device_id.strip()
    if not device_id or device_id == "unknown":
        raise HTTPException(status_code=422, detail="A known TV device must be selected")

    device = (
        db.query(TVDiagLog)
        .filter(TVDiagLog.device_id == device_id, TVDiagLog.user_id.isnot(None))
        .order_by(TVDiagLog.ts_server.desc())
        .first()
    )
    if device is None:
        raise HTTPException(status_code=404, detail="No account is associated with this TV device")

    requested_at = datetime.now(timezone.utc)
    shared_state = db.get(TVUserState, device.user_id)
    if shared_state is None:
        shared_state = TVUserState(user_id=device.user_id)
        db.add(shared_state)
    shared_state.remote_refresh_requested_at = requested_at
    shared_state.remote_refresh_device_id = device_id
    shared_state.updated_at = requested_at
    db.commit()
    logger.info(
        "ADMIN_TV_REFRESH_REQUEST admin_user_id=%s target_user_id=%s device_id=%s requested_at=%s",
        admin_user.id,
        device.user_id,
        device_id,
        requested_at.isoformat(),
    )
    return {
        "success": True,
        "device_id": device_id,
        "user_id": device.user_id,
        "requested_at": requested_at.isoformat(),
        "requested_device_id": device_id,
        "message": "Refresh request queued for the TV account.",
    }


@router.get("/system/tv-connection-gaps-summary")
def admin_tv_connection_gaps_summary(
    hours: int = 168,
    limit: int = 100,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    bounded_hours = max(1, min(int(hours or 168), 24 * 14))
    bounded_limit = max(1, min(int(limit or 100), 200))
    now_utc = datetime.now(timezone.utc)
    window_start = now_utc - timedelta(hours=bounded_hours)

    try:
        retention_days = int(os.getenv("TV_DIAG_RETENTION_DAYS", "14"))
    except ValueError:
        retention_days = 14
    history_start = now_utc - timedelta(days=max(1, min(retention_days, 365)))

    checkin_rows = (
        db.query(TVDiagLog, User.email)
        .outerjoin(User, User.id == TVDiagLog.user_id)
        .filter(
            TVDiagLog.event.in_(("device_presence", "heartbeat")),
            TVDiagLog.device_id.isnot(None),
            TVDiagLog.ts_server >= history_start,
        )
        .order_by(TVDiagLog.ts_server.asc())
        .all()
    )
    failure_events = (
        "tv_fetch_timeout",
        "tv_fetch_network_error",
        "token_invalid_401",
        "kiosk_token_invalid_401",
        "token_storage_removed",
        "storage_token_removed",
        "user_unpair_requested",
        "user_logout_requested",
    )
    failure_rows = (
        db.query(TVDiagLog)
        .filter(
            TVDiagLog.event.in_(failure_events),
            TVDiagLog.device_id.isnot(None),
            TVDiagLog.ts_server >= history_start,
        )
        .order_by(TVDiagLog.ts_server.asc())
        .all()
    )

    def as_utc(value: datetime) -> datetime:
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)

    grouped_checkins: dict[tuple[int | None, str], list[tuple[TVDiagLog, str | None]]] = {}
    for row, user_email in checkin_rows:
        key = (row.user_id, str(row.device_id))
        grouped_checkins.setdefault(key, []).append((row, user_email))

    grouped_failures: dict[tuple[int | None, str], list[TVDiagLog]] = {}
    for row in failure_rows:
        key = (row.user_id, str(row.device_id))
        grouped_failures.setdefault(key, []).append(row)

    gaps = []
    for key, rows in grouped_checkins.items():
        device_failures = grouped_failures.get(key, [])

        def append_gap(previous_pair, resumed_at: datetime | None, threshold_minutes: int, source_label: str) -> None:
            previous, user_email = previous_pair
            previous_at = as_utc(previous.ts_server)
            end_at = as_utc(resumed_at) if resumed_at else now_utc
            gap_minutes = max(0, int((end_at - previous_at).total_seconds() // 60))
            if gap_minutes < threshold_minutes:
                return

            matching_failures = [
                failure for failure in device_failures
                if previous_at < as_utc(failure.ts_server) <= end_at
            ]
            last_failure = matching_failures[-1] if matching_failures else None
            evidence = (
                f"{last_failure.event}: {last_failure.details or 'no details'}"
                if last_failure
                else f"No failure beacon received; inferred from missing {source_label}s."
            )
            gaps.append({
                "user_id": previous.user_id,
                "user_email": user_email,
                "device_id": previous.device_id,
                "device_ua": previous.device_ua,
                "last_checkin_at": previous_at.isoformat(),
                "resumed_at": end_at.isoformat() if resumed_at else None,
                "gap_minutes": gap_minutes,
                "status": "recovered" if resumed_at else "ongoing",
                "checkin_source": previous.event,
                "threshold_minutes": threshold_minutes,
                "evidence": evidence,
            })

        for previous_pair, resumed_pair in zip(rows, rows[1:]):
            resumed_at = as_utc(resumed_pair[0].ts_server)
            threshold_minutes = 45 if previous_pair[0].event == "device_presence" else 150
            source_label = "authenticated calendar check-in" if previous_pair[0].event == "device_presence" else "legacy heartbeat"
            if resumed_at >= window_start:
                append_gap(previous_pair, resumed_pair[0].ts_server, threshold_minutes, source_label)

        if rows:
            threshold_minutes = 45 if rows[-1][0].event == "device_presence" else 150
            source_label = "authenticated calendar check-in" if rows[-1][0].event == "device_presence" else "legacy heartbeat"
            latest_at = as_utc(rows[-1][0].ts_server)
            if latest_at < now_utc - timedelta(minutes=threshold_minutes):
                append_gap(rows[-1], None, threshold_minutes, source_label)

    gaps.sort(key=lambda row: row["resumed_at"] or row["last_checkin_at"], reverse=True)
    recent_rows = gaps[:bounded_limit]
    return {
        "checked_at": now_utc.isoformat(),
        "window": {"hours": bounded_hours, "start": window_start.isoformat(), "end": now_utc.isoformat()},
        "thresholds_minutes": {"device_presence": 45, "legacy_heartbeat": 150},
        "counts": {
            "connection_gaps": len(gaps),
            "recovered_gaps": sum(1 for row in gaps if row["status"] == "recovered"),
            "ongoing_gaps": sum(1 for row in gaps if row["status"] == "ongoing"),
            "unique_devices": len({row["device_id"] for row in gaps}),
        },
        "meaningful_points": [
            "A gap is inferred from missing successful device check-ins; it does not identify the exact outage start or prove the cause.",
            "A timeout or authentication event is included only if the TV successfully delivered that diagnostic during the gap.",
            "Legacy clients use a longer threshold because routine heartbeats are persisted hourly.",
        ],
        "recent_rows": recent_rows,
    }


@router.get("/system/overview")
def admin_system_overview(
    request: Request,
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
        "deployment": _deployment_sync_payload(request),
    }


@router.get("/system/database-config")
def admin_database_config(
    admin_user: User = Depends(require_admin),
):
    active_url = database_module.DATABASE_URL or DATABASE_URL
    active_mode = _database_runtime_mode(os.getenv("REQUIRE_DB_KIND") or active_url)
    provider_label = _configured_database_provider(active_url)
    connection = _active_database_connection_status()
    active_profile = next(
        (profile for profile in _database_profiles() if profile.get("database_url") == active_url),
        None,
    )
    is_postgres = active_url.startswith("postgresql")
    is_live = connection["connected"]
    active_copy_source = None
    if is_live and (is_postgres or active_url.startswith("sqlite")):
        active_copy_source = {
            "key": "__active_database__",
            "title": f"Active database - {_safe_database_summary(active_url)['label']}",
        }
    return {
        "database_mode": active_mode,
        "disable_sqlite_fallback": str(os.getenv("DISABLE_SQLITE_FALLBACK", "0")).strip().lower() in {"1", "true", "yes", "on"},
        "require_db_kind": os.getenv("REQUIRE_DB_KIND") or active_mode,
        "requires_restart": True,
        "summary": _safe_database_summary(active_url),
        "provider": provider_label,
        "provider_label": "Supabase - Postgres" if provider_label == "supabase" else "Neon - Postgres" if provider_label == "neon" else "SQLite" if provider_label == "sqlite" else "Postgres provider not identified",
        "profiles": _public_database_profiles(),
        "active_database_copy_source": active_copy_source,
        "active_provider_title": active_profile.get("title") if active_profile else provider_label,
        "live_database_confirmed": is_live,
        "connection_status": "connected" if is_live else "disconnected",
        "connection_message": connection["message"],
        "is_connected_to_postgres": is_live and is_postgres,
        "is_connected_to_supabase": is_live and provider_label == "supabase",
        "is_connected_to_neon": is_live and provider_label == "neon",
        "is_sqlite_fallback_active": active_mode == "sqlite" or not active_url or active_url.startswith("sqlite"),
        "runtime": "managed-origin" if is_production_environment() else "origin",
        "configuration_managed_by_host": is_production_environment(),
    }


@router.post("/system/database-config/test")
def admin_test_database_config(
    payload: DatabaseRuntimeConfigUpdate,
    admin_user: User = Depends(require_admin),
):
    if payload.database_mode not in {"sqlite", "postgres"}:
        raise HTTPException(status_code=422, detail="database_mode must be either sqlite or postgres.")

    candidate_url, _ = _resolve_database_config(payload)
    result = _test_database_url(candidate_url)
    parsed_candidate = make_url(candidate_url)
    connection_summary = _safe_database_summary(candidate_url)
    return {
        "ok": result["ok"],
        "database_mode": payload.database_mode,
        "message": result["message"],
        "summary": connection_summary,
        "connection_details": {
            "host": connection_summary["host"],
            "port": payload.database_port or parsed_candidate.port or ("n/a" if payload.database_mode == "sqlite" else "5432"),
            "database": connection_summary["database"],
            "ssl_mode": payload.ssl_mode or parsed_candidate.query.get("sslmode") or ("n/a" if payload.database_mode == "sqlite" else "require"),
        },
        "requires_restart": True,
    }


@router.post("/system/database-config/profile")
def admin_save_database_profile(
    payload: DatabaseRuntimeConfigUpdate,
    admin_user: User = Depends(require_admin),
):
    if payload.database_mode != "postgres":
        raise HTTPException(status_code=422, detail="Saved provider profiles currently support PostgreSQL only.")
    if is_production_environment():
        raise HTTPException(
            status_code=409,
            detail="This hosted origin uses provider-managed environment secrets. Save provider profiles in local development.",
        )
    if not (payload.provider_title or "").strip():
        raise HTTPException(status_code=422, detail="Enter a provider title before saving this profile.")

    database_url, connection_fields = _resolve_database_config(payload)
    validation = _test_database_url(database_url)
    if not validation["ok"]:
        raise HTTPException(status_code=400, detail=validation["message"])

    profile_engine = None
    try:
        profile_engine = _create_connected_database_engine(database_url)
        Base.metadata.create_all(bind=profile_engine)
    except Exception as exc:
        if profile_engine is not None:
            profile_engine.dispose()
        logger.warning("Database schema initialization failed (%s)", type(exc).__name__)
        raise HTTPException(
            status_code=400,
            detail="The connection succeeded, but the application schema could not be initialized. Verify database permissions and try again.",
        ) from exc
    else:
        profile_engine.dispose()

    saved_profile = _persist_database_profile(
        payload.provider_title,
        database_url,
        connection_fields,
    )
    return {
        "ok": True,
        "saved": saved_profile,
        "schema_initialized": True,
        "message": f"{payload.provider_title.strip()} was saved as a provider profile and the application tables were initialized. The active database was not changed.",
    }


@router.post("/system/database-config/copy")
def admin_copy_database_config(
    payload: DatabaseCopyRequest,
    admin_user: User = Depends(require_admin),
):
    if payload.source_provider == payload.target_provider:
        raise HTTPException(status_code=422, detail="Choose two different database providers.")
    profiles = {profile.get("title"): profile for profile in _database_profiles() if profile.get("title")}
    source = profiles.get(payload.source_provider)
    target = profiles.get(payload.target_provider)
    if not target or (payload.source_provider != "__active_database__" and not source):
        raise HTTPException(status_code=422, detail="Choose a valid active/saved source and a saved PostgreSQL target.")
    if payload.source_provider == "__active_database__":
        source_url = str(database_module.DATABASE_URL or "")
        source_supported = source_url.startswith(("postgresql", "sqlite"))
    else:
        source_url = str(source.get("database_url") or "") if source else ""
        source_supported = source_url.startswith(("postgresql", "sqlite"))
    target_url = str(target.get("database_url") or "")
    if source_url == target_url:
        raise HTTPException(status_code=422, detail="The source and target resolve to the same database.")
    if not source_supported or not target_url.startswith("postgresql"):
        raise HTTPException(status_code=422, detail="Copy requires an active or saved SQLite/PostgreSQL source and a saved PostgreSQL target.")
    try:
        copied = _copy_critical_database_data(source_url, target_url)
    except Exception as exc:
        logger.warning("Critical database copy failed (%s)", type(exc).__name__)
        raise HTTPException(
            status_code=502,
            detail="Database copy failed. Verify source and target connectivity, target permissions, and schema.",
        ) from exc
    return {
        "ok": True,
        "source_provider": payload.source_provider,
        "target_provider": payload.target_provider,
        "tables": copied,
        "message": "Critical application data and encrypted provider credentials were copied additively. Existing target rows were preserved. The destination must use the same TOKEN_ENCRYPTION_KEY for copied OAuth tokens to remain usable.",
    }


@router.post("/system/database-config")
def admin_apply_database_config(
    payload: DatabaseRuntimeConfigUpdate,
    admin_user: User = Depends(require_admin),
):
    if payload.database_mode not in {"sqlite", "postgres"}:
        raise HTTPException(status_code=422, detail="database_mode must be either sqlite or postgres.")

    database_url, connection_fields = _resolve_database_config(payload)
    validation = _test_database_url(database_url)
    if not validation["ok"]:
        raise HTTPException(status_code=400, detail=validation["message"])

    try:
        replacement_engine = _create_connected_database_engine(database_url)
    except Exception as exc:
        logger.warning("Could not create the replacement database engine: %s", type(exc).__name__)
        raise HTTPException(status_code=400, detail=validation["message"]) from exc

    try:
        saved = _persist_runtime_database_config(
            database_url,
            payload.database_mode,
            payload.disable_sqlite_fallback,
            payload.provider_title,
            connection_fields["database_user"],
            connection_fields["database_password"],
            connection_fields["database_host"],
            connection_fields["database_name"],
            connection_fields["ssl_mode"],
            connection_fields["database_port"],
        )
    except Exception:
        replacement_engine.dispose()
        raise

    previous_engine = database_module.engine
    globals()["DATABASE_URL"] = database_url
    os.environ["DATABASE_URL"] = database_url
    os.environ["REQUIRE_DB_KIND"] = payload.database_mode
    os.environ["DISABLE_SQLITE_FALLBACK"] = "1" if payload.disable_sqlite_fallback else "0"
    os.environ["DB_TYPE"] = payload.database_mode

    database_module.DATABASE_URL = database_url
    database_module.engine = replacement_engine
    database_module.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=database_module.engine)
    globals()["engine"] = replacement_engine
    previous_engine.dispose()

    return {
        "ok": True,
        "message": "Database configuration saved and the active connection was switched. Restart the app to fully reload background services.",
        "saved": saved,
        "summary": _safe_database_summary(database_url),
        "requires_restart": True,
    }


@router.post("/system/database-config/disconnect")
def admin_disconnect_database(
    admin_user: User = Depends(require_admin),
):
    result = admin_apply_database_config(
        DatabaseRuntimeConfigUpdate(
            database_mode="sqlite",
            database_url=f"sqlite:///{os.getenv('SQLITE_PATH', './app.db')}",
            disable_sqlite_fallback=False,
        ),
        admin_user,
    )
    result["message"] = (
        "PostgreSQL disconnected. The app is now using SQLite; database contents were not copied. "
        "Restart the app to fully reload background services."
    )
    result["saved"]["provider_title"] = None
    return result


@router.post("/system/render/redeploy")
def admin_trigger_render_redeploy(
    admin_user: User = Depends(require_admin),
):
    return _trigger_render_deploy_hook()


@router.post("/system/cloudflare/redeploy")
def admin_trigger_cloudflare_redeploy(
    admin_user: User = Depends(require_admin),
):
    return _trigger_cloudflare_deploy_hook()


@router.post("/system/github/commit-push")
def admin_launch_git_commit_push(
    payload: GitCommitPushRequest,
    admin_user: User = Depends(require_admin),
):
    if not verify_password(payload.password, admin_user.hashed_password):
        raise HTTPException(status_code=403, detail="Admin password is incorrect.")
    return _launch_git_commit_script()


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
    pk_columns = set(inspector.get_pk_constraint(table_name).get("constrained_columns") or [])
    schema = [
        {
            "name": col["name"],
            "type": str(col.get("type") or ""),
            "nullable": bool(col.get("nullable")),
            "default": col.get("default"),
            "primary_key": col["name"] in pk_columns,
            "redacted": col["name"] in REDACTED_COLUMNS,
        }
        for col in inspector.get_columns(table_name)
    ]

    return {
        "table": table_name,
        "columns": columns,
        "schema": schema,
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

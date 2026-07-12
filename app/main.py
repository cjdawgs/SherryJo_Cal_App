
# ==================================================
# IMPORTS
# ==================================================

import logging

from fastapi import FastAPI, Request
from fastapi.openapi.utils import get_openapi
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import inspect, text
from datetime import datetime, timezone

from app.database import engine, Base
from app.services.asset_urls import asset_import_map_json, asset_url

# ✅ Import ALL routers from your central router registry
from app.routers import all_routers


# ✅ NEW: Import background scheduler
from app.services.sync_scheduler import start_scheduler


def apply_log_noise_filters():
    """
    Keep app debug logs readable by muting verbose third-party ICS/CALDAV internals.
    """
    noisy_loggers = [
        "caldav",
        "vobject",
        "icalendar",
        "recurring_ical_events",
        "urllib3.connectionpool",
    ]

    for name in noisy_loggers:
        logging.getLogger(name).setLevel(logging.WARNING)

    class _NoisyIcalFilter(logging.Filter):
        def filter(self, record):
            msg = record.getMessage() if record else ""
            blocked_snippets = (
                "Ical data was modified to avoid compatibility issues",
                "Your calendar server breaks the icalendar standard",
                "error count:",
            )

            if any(snip in msg for snip in blocked_snippets):
                return False

            if msg.startswith("--- ") or msg.startswith("+++ ") or msg.startswith("@@ "):
                return False

            return True

    root_logger = logging.getLogger()
    root_logger.addFilter(_NoisyIcalFilter())


apply_log_noise_filters()



# ==================================================
# CREATE FASTAPI APP
# ==================================================

app = FastAPI(
    title="SherryJo App",
    version="1.0"
)


REQUIRED_TABLES = {
    "users",
    "oauth_accounts",
    "events",
    "tasks",
    "notes",
    "date_sticky_notes",
}


def evaluate_schema_health(db_engine=engine):
    checked_at = datetime.now(timezone.utc).isoformat()
    try:
        inspector = inspect(db_engine)
        existing_tables = set(inspector.get_table_names())
        missing_tables = sorted(REQUIRED_TABLES - existing_tables)

        if missing_tables:
            message = (
                "Missing required tables. Run database migrations before handling sticky/date routes "
                "(for example: alembic upgrade head)."
            )
            print(f"⚠️ [SCHEMA CHECK] Missing tables: {missing_tables}")
            print("⚠️ [SCHEMA CHECK] Migration warning:", message)
            return {
                "status": "warning",
                "checked_at": checked_at,
                "required_tables": sorted(REQUIRED_TABLES),
                "missing_tables": missing_tables,
                "message": message,
            }

        print("✅ [SCHEMA CHECK] All required tables are present.")
        return {
            "status": "ok",
            "checked_at": checked_at,
            "required_tables": sorted(REQUIRED_TABLES),
            "missing_tables": [],
            "message": "Schema check passed",
        }

    except Exception as e:
        print("❌ [SCHEMA CHECK] Failed to inspect schema:", str(e))
        return {
            "status": "error",
            "checked_at": checked_at,
            "required_tables": sorted(REQUIRED_TABLES),
            "missing_tables": [],
            "message": f"Schema check failed: {str(e)}",
        }


# ==================================================
# ✅ ENABLE CORS (ALLOW FRONTEND TO CALL API)
# ==================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://sherryjo-cal-app.onrender.com",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==================================================
# DATABASE INITIALIZATION
# ==================================================

# ✅ IMPORTANT:
# This ensures SQLAlchemy knows about all models before creating tables
from app import models  # DO NOT REMOVE

# ✅ Create tables (safe for dev; in prod you'd use migrations)
Base.metadata.create_all(bind=engine)

# ✅ Ensure PostgreSQL schema is up to date for optional columns used by current code.
if engine.url.drivername.startswith("postgresql"):
    inspector = inspect(engine)

    if "oauth_accounts" in inspector.get_table_names():
        columns = {col["name"] for col in inspector.get_columns("oauth_accounts")}
        required_columns = {
            "last_sync_success",
            "last_sync_failure",
            "last_error",
            "status",
            "token_expires_at",
            "updated_at",
            "color",
            "is_service_provider",
            "sync_frequency_minutes",
            "sync_range_days",
            "last_manual_refresh_at",
        }
        missing = required_columns - columns
        if missing:
            print(f"⚠️ PostgreSQL oauth_accounts schema missing columns: {missing}. Applying ALTER TABLE fixes.")
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS last_sync_success TIMESTAMPTZ"))
                conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS last_sync_failure TIMESTAMPTZ"))
                conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS last_error VARCHAR"))
                conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS status VARCHAR DEFAULT 'ok'"))
                conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ"))
                conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ"))
                conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS color VARCHAR"))
                conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS is_service_provider BOOLEAN DEFAULT FALSE"))
                conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS sync_frequency_minutes INTEGER DEFAULT 5"))
                conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS sync_range_days INTEGER DEFAULT 30"))
                conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS last_manual_refresh_at TIMESTAMPTZ"))
                conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS sync_token JSONB"))
                conn.execute(text("UPDATE oauth_accounts SET sync_frequency_minutes = 5 WHERE sync_frequency_minutes IS NULL"))
                conn.execute(text("UPDATE oauth_accounts SET sync_range_days = 30 WHERE sync_range_days IS NULL"))
                conn.execute(text("UPDATE oauth_accounts SET is_service_provider = TRUE WHERE access_token = 'admin-placeholder-token'"))
                conn.execute(text("UPDATE oauth_accounts SET is_service_provider = FALSE WHERE is_service_provider IS NULL"))
                conn.commit()
            print("✅ PostgreSQL oauth_accounts schema upgrade complete.")

    if "events" in inspector.get_table_names():
        event_columns = {col["name"] for col in inspector.get_columns("events")}
        required_event_columns = {
            "color",
            "tags",
            "sticky_note",
            "sticky_notes",
            "updated_at"
        }
        missing_event_columns = required_event_columns - event_columns

        if missing_event_columns:
            print(f"⚠️ PostgreSQL events schema missing columns: {missing_event_columns}. Applying ALTER TABLE fixes.")
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE events ADD COLUMN IF NOT EXISTS color VARCHAR"))
                conn.execute(text("ALTER TABLE events ADD COLUMN IF NOT EXISTS tags JSONB"))
                conn.execute(text("ALTER TABLE events ADD COLUMN IF NOT EXISTS sticky_note JSONB"))
                conn.execute(text("ALTER TABLE events ADD COLUMN IF NOT EXISTS sticky_notes JSONB"))
                conn.execute(text("ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ"))
                conn.commit()
            print("✅ PostgreSQL events schema upgrade complete.")

    if "date_sticky_notes" in inspector.get_table_names():
        date_sticky_columns = {col["name"] for col in inspector.get_columns("date_sticky_notes")}
        if "sticky_notes" not in date_sticky_columns:
            print("⚠️ PostgreSQL date_sticky_notes schema missing sticky_notes. Applying ALTER TABLE fix.")
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE date_sticky_notes ADD COLUMN IF NOT EXISTS sticky_notes JSONB"))
                conn.commit()
            print("✅ PostgreSQL date_sticky_notes schema upgrade complete.")
        else:
            print("✅ PostgreSQL date_sticky_notes.sticky_notes present.")

# ✅ Ensure local SQLite schema is up to date for optional columns
if engine.url.drivername.startswith("sqlite"):
    inspector = inspect(engine)
    if "oauth_accounts" in inspector.get_table_names():
        columns = {col["name"] for col in inspector.get_columns("oauth_accounts")}
        required_columns = {
            "last_sync_success",
            "last_sync_failure",
            "last_error",
            "status",
            "token_expires_at",
            "updated_at",
            "color",
            "is_service_provider",
            "sync_frequency_minutes",
            "sync_range_days",
            "last_manual_refresh_at",
            "sync_token",
        }
        missing = required_columns - columns
        if missing:
            print(f"⚠️ SQLite schema missing columns: {missing}. Applying ALTER TABLE fixes.")
            with engine.connect() as conn:
                for col in missing:
                    if col == "last_sync_success":
                        conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN last_sync_success DATETIME"))
                    elif col == "last_sync_failure":
                        conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN last_sync_failure DATETIME"))
                    elif col == "last_error":
                        conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN last_error VARCHAR"))
                    elif col == "status":
                        conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN status VARCHAR DEFAULT 'ok'"))
                    elif col == "token_expires_at":
                        conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN token_expires_at DATETIME"))
                    elif col == "updated_at":
                        conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN updated_at DATETIME"))
                    elif col == "color":
                        conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN color VARCHAR"))
                    elif col == "is_service_provider":
                        conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN is_service_provider BOOLEAN DEFAULT 0"))
                    elif col == "sync_frequency_minutes":
                        conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN sync_frequency_minutes INTEGER DEFAULT 5"))
                    elif col == "sync_range_days":
                        conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN sync_range_days INTEGER DEFAULT 30"))
                    elif col == "last_manual_refresh_at":
                        conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN last_manual_refresh_at DATETIME"))
                    elif col == "sync_token":
                        conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN sync_token JSON"))
                conn.execute(text("UPDATE oauth_accounts SET sync_frequency_minutes = 5 WHERE sync_frequency_minutes IS NULL"))
                conn.execute(text("UPDATE oauth_accounts SET sync_range_days = 30 WHERE sync_range_days IS NULL"))
                conn.execute(text("UPDATE oauth_accounts SET is_service_provider = 1 WHERE access_token = 'admin-placeholder-token'"))
                conn.execute(text("UPDATE oauth_accounts SET is_service_provider = 0 WHERE is_service_provider IS NULL"))
                conn.commit()
            print("✅ SQLite schema upgrade complete.")

    if "events" in inspector.get_table_names():
        event_columns = {col["name"] for col in inspector.get_columns("events")}
        required_event_columns = {
            "color",
            "tags",
            "sticky_note",
            "sticky_notes",
            "updated_at"
        }
        missing_event_columns = required_event_columns - event_columns

        if missing_event_columns:
            print(f"⚠️ SQLite events schema missing columns: {missing_event_columns}. Applying ALTER TABLE fixes.")
            with engine.connect() as conn:
                for col in missing_event_columns:
                    if col == "color":
                        conn.execute(text("ALTER TABLE events ADD COLUMN color VARCHAR"))
                    elif col == "tags":
                        conn.execute(text("ALTER TABLE events ADD COLUMN tags JSON"))
                    elif col == "sticky_note":
                        conn.execute(text("ALTER TABLE events ADD COLUMN sticky_note JSON"))
                    elif col == "sticky_notes":
                        conn.execute(text("ALTER TABLE events ADD COLUMN sticky_notes JSON"))
                    elif col == "updated_at":
                        conn.execute(text("ALTER TABLE events ADD COLUMN updated_at DATETIME"))
                conn.commit()
            print("✅ SQLite events schema upgrade complete.")

    if "date_sticky_notes" in inspector.get_table_names():
        date_sticky_columns = {col["name"] for col in inspector.get_columns("date_sticky_notes")}
        if "sticky_notes" not in date_sticky_columns:
            print("⚠️ SQLite date_sticky_notes schema missing sticky_notes. Applying ALTER TABLE fix.")
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE date_sticky_notes ADD COLUMN sticky_notes JSON"))
                conn.commit()
            print("✅ SQLite date_sticky_notes schema upgrade complete.")
        else:
            print("✅ SQLite date_sticky_notes.sticky_notes present.")

print("✅ Tables registered:", Base.metadata.tables.keys())


# ==================================================
# ONE-TIME BACKFILL: external_ids for existing synced events
# --------------------------------------------------
# Events synced before the write-back feature was added have
# external_ids = NULL.  We reconstruct the raw provider ID from
# the composite externalId column (format: "provider:account_email:raw_id").
# Fallback IDs (starting with "fb:") are NOT real provider IDs and are skipped.
# This block is idempotent — safe to run on every startup.
# ==================================================
try:
    from app.database import SessionLocal as _SL
    from app.models import Event as _Ev

    with _SL() as _sess:
        _to_backfill = (
            _sess.query(_Ev)
            .filter(
                _Ev.external_ids.is_(None),
                _Ev.externalId.isnot(None),
                _Ev.source.in_(["google", "microsoft", "apple"]),
            )
            .all()
        )

        _filled = 0
        _upgraded = 0
        for _ev in _to_backfill:
            try:
                _parts = (_ev.externalId or "").split(":", 2)
                if len(_parts) == 3:
                    _provider, _acct_email, _raw_id = _parts
                    # Skip fallback synthetic IDs — they are not real provider IDs
                    if _raw_id and not _raw_id.startswith("fb:"):
                        # Use provider:account_email key so multi-account write-back works
                        _key = f"{_provider}:{_acct_email}" if _acct_email else _provider
                        _ev.external_ids = {_key: _raw_id}
                        _filled += 1
            except Exception:
                continue

        # Also upgrade any previously-backfilled rows that used the old
        # bare-provider key format {"google": "raw_id"} → {"google:email": "raw_id"}
        _to_upgrade = (
            _sess.query(_Ev)
            .filter(
                _Ev.external_ids.isnot(None),
                _Ev.externalId.isnot(None),
                _Ev.source.in_(["google", "microsoft", "apple"]),
            )
            .all()
        )
        for _ev in _to_upgrade:
            _ids = dict(_ev.external_ids or {})
            _needs_upgrade = any(":" not in k for k in _ids)
            if not _needs_upgrade:
                continue
            _parts = (_ev.externalId or "").split(":", 2)
            if len(_parts) != 3:
                continue
            _provider, _acct_email, _raw_id = _parts
            if not _raw_id or _raw_id.startswith("fb:"):
                continue
            _new_key = f"{_provider}:{_acct_email}" if _acct_email else _provider
            _new_ids = {k: v for k, v in _ids.items() if ":" in k}
            _new_ids[_new_key] = _raw_id
            _ev.external_ids = _new_ids
            _upgraded += 1

        if _filled or _upgraded:
            _sess.commit()
            print(f"✅ [BACKFILL] external_ids: filled={_filled} upgraded={_upgraded}")
        else:
            print("✅ [BACKFILL] external_ids: nothing to backfill")

except Exception as _bf_err:
    print(f"⚠️ [BACKFILL] external_ids backfill failed (non-fatal): {_bf_err}")


# ==================================================
# TEMPLATE ENGINE (JINJA2)
# ==================================================

# ✅ Loads HTML templates from /app/templates
templates = Jinja2Templates(directory="app/templates")
templates.env.globals.update(
    asset_url=asset_url,
    asset_import_map_json=asset_import_map_json,
)


INDEX_ASSET_IMPORTS = {
    "/static/api.js": "api.js",
    "/static/account_connections.js": "account_connections.js",
    "/static/calendar.fullcalendar.js": "calendar.fullcalendar.js",
    "/static/calendar.ui.js": "calendar.ui.js",
    "/static/calendar.js": "calendar.js",
    "/static/core.js": "core.js",
    "/static/undo_redo.js": "undo_redo.js",
}


# ==================================================
# STATIC FILES (CSS, JS)
# ==================================================

# ✅ Serves static assets at /static
app.mount("/static", StaticFiles(directory="app/static"), name="static")


# ==================================================
# REGISTER ROUTERS
# ==================================================
# ✅ Dynamically include all routers
for r in all_routers:
    app.include_router(r)



# ==================================================
# ✅ BACKGROUND JOBS (NEW)
# ==================================================

@app.on_event("startup")
def start_background_jobs():
    """
    Runs when FastAPI starts.

    Purpose:
    - Start background scheduler
    - Automatically sync Outlook events periodically

    IMPORTANT:
    This ensures:
    - No manual API calls needed
    - System stays in sync with Outlook
    """
    app.state.schema_health = evaluate_schema_health()

    try:
        start_scheduler()
    except Exception as e:
        print("⚠️ Scheduler failed to start:", str(e))


# ==================================================
# MAIN PAGE (UI ENTRY POINT)
# ==================================================

@app.get("/")
def home(request: Request):
    """
    ✅ Landing page for your app UI
    """

    
    return templates.TemplateResponse(
        request,
        "index.html",
        {
            "request": request,
            "asset_imports": INDEX_ASSET_IMPORTS,
        }
    )


@app.head("/", include_in_schema=False)
def home_head():
    # Some platforms/browsers probe with HEAD / before GET /.
    return Response(status_code=200)


@app.get("/calendar-ui")
def calendar_ui(request: Request):
    
    return templates.TemplateResponse(
        request,
        "index.html",
        {
            "request": request,
            "asset_imports": INDEX_ASSET_IMPORTS,
        }
    )



@app.get("/login")
def login_page(request: Request):
    return templates.TemplateResponse(
        request,
        "login.html",
        {"request": request}
    )


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return Response(status_code=204)

# ==================================================
# HEALTH CHECK
# ==================================================

@app.get("/health")
def health_check():
    """
    ✅ Simple health endpoint (used by tests + monitoring)
    """
    schema_health = getattr(app.state, "schema_health", None)
    if schema_health is None:
        schema_health = evaluate_schema_health()
        app.state.schema_health = schema_health

    return {
        "status": "ok",
        "app": "running",
        "schema_status": schema_health.get("status", "unknown")
    }


@app.head("/health", include_in_schema=False)
def health_check_head():
    return Response(status_code=200)


@app.get("/health/schema")
def schema_health_check(refresh: bool = False):
    if refresh or not hasattr(app.state, "schema_health"):
        app.state.schema_health = evaluate_schema_health()
    return app.state.schema_health


# ==================================================
# CUSTOM OPENAPI (SWAGGER CONFIG)
# ==================================================

def custom_openapi():
    """
    ✅ Hook to customize Swagger/OpenAPI

    Currently:
    - Returns default schema (safe)
    - Keeps future option open for JWT enhancements

    You can later inject:
    - Bearer auth config
    - Tags / descriptions
    - API grouping
    """

    if app.openapi_schema:
        return app.openapi_schema

    openapi_schema = get_openapi(
        title=app.title,
        version=app.version,
        routes=app.routes,
    )

    # ✅ OPTIONAL FUTURE IMPROVEMENT:
    # Add JWT Bearer auth to Swagger globally
    #
    # openapi_schema["components"]["securitySchemes"] = {
    #     "BearerAuth": {
    #         "type": "http",
    #         "scheme": "bearer",
    #         "bearerFormat": "JWT"
    #     }
    # }
    #
    # openapi_schema["security"] = [{"BearerAuth": []}]

    app.openapi_schema = openapi_schema
    return app.openapi_schema


# ✅ Attach custom OpenAPI function
app.openapi = custom_openapi


# ==========================================
# TEMPORARY TEST ROUTE
# Used to verify the FastAPI application is running correctly.
# Safe to remove once integration (OAuth / Graph API) is completed.
# ==========================================
@app.get("/copilot-test")
def copilot_test():
    return {"message": "Copilot test route working!"}


# --------------------------------------------------
# Standard Library Imports
# --------------------------------------------------
import os
from typing import Any

# --------------------------------------------------
# Third-Party Imports
# --------------------------------------------------
import psycopg2
from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict


def _is_truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def is_production_environment() -> bool:
    """Return True when running in production-like hosting contexts."""
    env_name = (os.getenv("ENV") or os.getenv("APP_ENV") or os.getenv("ENVIRONMENT") or "").strip().lower()
    if env_name in {"prod", "production", "stage", "staging"}:
        return True

    # Common cloud host markers; if present, prefer host-provided env over local .env.
    if os.getenv("WEBSITE_SITE_NAME") or os.getenv("AZURE_HTTP_USER_AGENT"):
        return True

    return False


# --------------------------------------------------
# Load environment variables from .env
# Dev-only: never let local .env override production runtime settings.
# --------------------------------------------------
if not is_production_environment() and not _is_truthy(os.getenv("DISABLE_DOTENV")):
    load_dotenv(override=False)


# --------------------------------------------------
# Pydantic Settings Class
# (keeps your original app configuration structure)
# --------------------------------------------------
class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        extra="ignore"  # ✅ Allows extra vars in .env (CRITICAL FIX)
    )

    # Environment (dev, prod, etc.)
    env: str = "dev"

    # Optional DB field (we override dynamically below)
    database_url: str | None = None

    # ✅ ADD THESE 3 LINES for MICROSOFT OAUTH CONFIG
    MS_CLIENT_ID: str
    MS_CLIENT_SECRET: str
    MS_TENANT_ID: str 
    MS_REDIRECT_URI: str

    BASE_URL: str = "http://127.0.0.1:8000"

    
    # ✅ ADD THESE 3 LINES for the "google_calendar_service" config
    GOOGLE_CLIENT_ID: str
    GOOGLE_CLIENT_SECRET: str
    GOOGLE_REDIRECT_URI: str

    # Security settings
    jwt_secret_key: str
    jwt_algorithm: str = "HS256"

    # App metadata
    app_name: str = "SherryJo Calendar API"


# Instantiate settings object
settings = Settings()


def _normalize_base_url(base_url: str) -> str:
    return str(base_url or "").strip().rstrip("/")


def resolve_runtime_base_url(request: Any = None) -> str:
    """
    Resolve externally reachable base URL with strong precedence rules.

    Order:
    1) Explicit BASE_URL env when it is non-localhost
    2) Forwarded headers / request host (works for DevTunnel/reverse proxies)
    3) Explicit BASE_URL env (including local fallback)
    4) localhost default
    """
    configured_base_url = _normalize_base_url(settings.BASE_URL)

    # Respect explicit non-local URLs first.
    lowered = configured_base_url.lower()
    if configured_base_url and not (
        lowered.startswith("http://127.0.0.1")
        or lowered.startswith("http://localhost")
        or lowered.startswith("https://localhost")
    ):
        return configured_base_url

    if request is not None:
        headers = getattr(request, "headers", {})

        forwarded_host = (headers.get("x-forwarded-host") or "").strip()
        forwarded_proto = (headers.get("x-forwarded-proto") or "https").strip() or "https"
        if forwarded_host:
            return _normalize_base_url(f"{forwarded_proto}://{forwarded_host}")

        host = (headers.get("host") or "").strip()
        scheme = (getattr(getattr(request, "url", None), "scheme", None) or "http").strip()
        if host:
            return _normalize_base_url(f"{scheme}://{host}")

    if configured_base_url:
        return configured_base_url

    return "http://127.0.0.1:8000"


def get_google_redirect_uri(request: Any = None) -> str:
    # Single source of truth for Google callback URI across local and DevTunnel runs.
    return f"{resolve_runtime_base_url(request)}/auth/google/callback"


def get_ms_redirect_uri(request: Any = None) -> str:
    # Single source of truth for Microsoft callback URI across local and DevTunnel runs.
    return f"{resolve_runtime_base_url(request)}/ms/callback"


def validate_runtime_configuration() -> None:
    """Fail fast for production deployments missing required env vars."""
    if not is_production_environment():
        return

    required_keys = [
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "MS_CLIENT_ID",
        "MS_CLIENT_SECRET",
        "MS_TENANT_ID",
        "jwt_secret_key",
    ]

    missing = [key for key in required_keys if not getattr(settings, key, None)]
    if missing:
        joined = ", ".join(sorted(missing))
        raise RuntimeError(f"Missing required production environment variables: {joined}")


validate_runtime_configuration()


# --------------------------------------------------
# Database Mode Selection
# --------------------------------------------------
# Options:
#   "postgres" → force PostgreSQL
#   "sqlite"   → force SQLite
#   "auto"     → try Postgres, fallback to SQLite
# --------------------------------------------------
DB_TYPE = os.getenv("DB_TYPE", "auto")


# --------------------------------------------------
# Function: Test PostgreSQL Connection (REAL LOGIN)
# --------------------------------------------------
def can_connect_postgres():
    """
    Attempt a real PostgreSQL login using credentials from .env.

    ✅ Returns True ONLY if authentication succeeds
    ❌ Returns False if:
       - PostgreSQL is not installed
       - Server is not running
       - Credentials are wrong
       - Database does not exist
    """
    try:
        conn = psycopg2.connect(
            dbname=os.getenv("POSTGRES_DB"),
            user=os.getenv("POSTGRES_USER"),
            password=os.getenv("POSTGRES_PASSWORD"),
            host=os.getenv("POSTGRES_HOST", "localhost"),
            port=os.getenv("POSTGRES_PORT", "5432"),
            connect_timeout=2
        )
        conn.close()
        return True

    except Exception as e:
        print(f"[CONFIG] Postgres connection failed: {e}")
        return False


# --------------------------------------------------
# Resolve Which Database to Use
# --------------------------------------------------
if DB_TYPE == "postgres":
    # User explicitly wants PostgreSQL
    if can_connect_postgres():
        resolved_db = "postgres"
    else:
        print("⚠️ WARNING: PostgreSQL requested but login failed → using SQLite")
        resolved_db = "sqlite"

elif DB_TYPE == "sqlite":
    # User explicitly wants SQLite
    resolved_db = "sqlite"

else:
    # AUTO MODE (recommended)
    if can_connect_postgres():
        resolved_db = "postgres"
    else:
        print("ℹ️ PostgreSQL not usable → falling back to SQLite")
        resolved_db = "sqlite"


# --------------------------------------------------
# Build Final DATABASE_URL
# --------------------------------------------------
if resolved_db == "postgres":
    DATABASE_URL = (
        f"postgresql+psycopg2://{os.getenv('POSTGRES_USER')}:"
        f"{os.getenv('POSTGRES_PASSWORD')}@"
        f"{os.getenv('POSTGRES_HOST', 'localhost')}:"
        f"{os.getenv('POSTGRES_PORT', '5432')}/"
        f"{os.getenv('POSTGRES_DB')}"
    )

else:
    SQLITE_PATH = os.getenv("SQLITE_PATH", "./app.db")
    DATABASE_URL = f"sqlite:///{SQLITE_PATH}"


# --------------------------------------------------
# Debug / Visibility Output (Safe to Keep)
# --------------------------------------------------
print(f"[CONFIG] Environment: {settings.env}")
print(f"[CONFIG] DB_TYPE requested: {DB_TYPE}")
print(f"[CONFIG] DB_TYPE resolved to: {resolved_db}")
print(f"[CONFIG] Using database: {DATABASE_URL}")

# --------------------------------------------------
# Standard Library Imports
# --------------------------------------------------
import os
from typing import Any
from urllib.parse import urlsplit, urlunsplit

# --------------------------------------------------
# Third-Party Imports
# --------------------------------------------------
import psycopg2
from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import create_engine


def mask_database_url(url: str | None) -> str:
    """Render a connection string without its credentials for safe logging."""
    parts = urlsplit(str(url or ""))
    if not parts.netloc or "@" not in parts.netloc:
        return str(url or "")

    host = parts.netloc.rsplit("@", 1)[1]
    return urlunsplit((parts.scheme, f"***:***@{host}", parts.path, parts.query, parts.fragment))


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

    # Render sets these on every service instance.
    if os.getenv("RENDER") or os.getenv("RENDER_SERVICE_ID"):
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

    # Credential encryption at rest (see app/utils/crypto.py).
    # Comma-separated Fernet keys; the first one encrypts, the rest decrypt.
    token_encryption_key: str | None = None

    # App metadata
    app_name: str = "SherryJo Calendar API"

    # Local AI settings (Ollama / LM Studio)
    AI_PROVIDER: str = "ollama"
    AI_MODEL: str = "qwen2.5:7b"
    AI_OLLAMA_BASE_URL: str = "http://127.0.0.1:11434"
    AI_LMSTUDIO_BASE_URL: str = "http://127.0.0.1:1234/v1"
    AI_LMSTUDIO_API_KEY: str = "lm-studio"
    AI_REQUEST_TIMEOUT_SECONDS: int = 60


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


REQUIRED_PRODUCTION_SETTINGS = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "MS_CLIENT_ID",
    "MS_CLIENT_SECRET",
    "MS_TENANT_ID",
    "jwt_secret_key",
    # Without this, OAuth tokens and iCloud app passwords are stored in clear text.
    "token_encryption_key",
]

REQUIRED_PRODUCTION_ENV_VARS = [
    # Blocks self-service admin registration.
    "ADMIN_SETUP_CODE",
]

REQUIRED_PRODUCTION_ENV_VALUES = {
    # A production outage must not silently degrade into an ephemeral local
    # SQLite database that quietly loses every write on the next redeploy.
    "DISABLE_SQLITE_FALLBACK": {"1", "true", "yes", "on"},
    "REQUIRE_DB_KIND": {"postgres"},
}


def missing_production_configuration() -> list:
    """Names of required production settings that are unset or misconfigured."""
    missing = [
        key for key in REQUIRED_PRODUCTION_SETTINGS if not getattr(settings, key, None)
    ]

    missing.extend(
        name for name in REQUIRED_PRODUCTION_ENV_VARS if not (os.getenv(name) or "").strip()
    )

    for name, allowed in REQUIRED_PRODUCTION_ENV_VALUES.items():
        value = (os.getenv(name) or "").strip().lower()
        if value not in allowed:
            expected = "|".join(sorted(allowed))
            missing.append(f"{name} (must be one of: {expected})")

    return sorted(missing)


def validate_runtime_configuration() -> None:
    """Fail fast for production deployments missing required env vars."""
    if not is_production_environment():
        return

    missing = missing_production_configuration()
    if missing:
        joined = ", ".join(missing)
        raise RuntimeError(f"Missing required production environment variables: {joined}")


validate_runtime_configuration()

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

DATABASE_URL_ENV = os.getenv("DATABASE_URL")
DB_TYPE = os.getenv("DB_TYPE", "auto")

if DATABASE_URL_ENV:
    # ✅ PRIORITY: Use external DB (Supabase / Render / etc.)
    print("✅ Using DATABASE_URL from environment")
    DATABASE_URL = DATABASE_URL_ENV

    # Optional parse type just for logging
    if "postgres" in DATABASE_URL_ENV:
        resolved_db = "postgres"
    elif "sqlite" in DATABASE_URL_ENV:
        resolved_db = "sqlite"
    else:
        resolved_db = "unknown"
    
else:

    # --------------------------------------------------
    # Fallback to your existing logic
    # Database Mode Selection
    # --------------------------------------------------
    # Options:
    #   "postgres" → force PostgreSQL
    #   "sqlite"   → force SQLite
    #   "auto"     → try Postgres, fallback to SQLite
    # --------------------------------------------------


    if DB_TYPE == "postgres":
        if can_connect_postgres():
            resolved_db = "postgres"
        else:
            print("⚠️ PostgreSQL requested but login failed → using SQLite")
            resolved_db = "sqlite"

    elif DB_TYPE == "sqlite":
        resolved_db = "sqlite"

    else:
        if can_connect_postgres():
            resolved_db = "postgres"
        else:
            print("ℹ️ PostgreSQL not usable → falling back to SQLite")
            resolved_db = "sqlite"

    # Build fallback connection string
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
print(f"[CONFIG] Using database: {mask_database_url(DATABASE_URL)}")

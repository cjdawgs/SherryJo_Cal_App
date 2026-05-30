# --------------------------------------------------
# Standard Library Imports
# --------------------------------------------------
import os

# --------------------------------------------------
# Third-Party Imports
# --------------------------------------------------
import psycopg2
from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict


# --------------------------------------------------
# Load environment variables from .env
# override=True ensures .env values always apply
# --------------------------------------------------
load_dotenv(override=True)


# --------------------------------------------------
# Pydantic Settings Class
# (keeps your original app configuration structure)
# --------------------------------------------------
class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
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

import os
import tempfile
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

from app.config import DATABASE_URL


# --------------------------------------------------
# Engine Configuration
# --------------------------------------------------

engine_kwargs = {}


def _sqlite_path_candidates(primary_url: str):
    candidates = [primary_url]

    local_root = os.getenv("LOCALAPPDATA") or tempfile.gettempdir()
    fallback_dir = Path(local_root) / "SherryJoCalApp"
    fallback_dir.mkdir(parents=True, exist_ok=True)
    fallback_url = f"sqlite:///{(fallback_dir / 'app.db').as_posix()}"

    if fallback_url not in candidates:
        candidates.append(fallback_url)

    return candidates


def _create_sqlite_engine_with_fallback(primary_url: str):
    last_error = None

    for candidate in _sqlite_path_candidates(primary_url):
        try:
            engine = create_engine(
                candidate,
                connect_args={"check_same_thread": False}
            )
            with engine.connect() as conn:
                conn.exec_driver_sql("SELECT 1")
            print(f"✅ SQLite engine ready: {candidate}")
            return engine, candidate
        except Exception as exc:
            last_error = exc
            print(f"⚠️ SQLite path failed ({candidate}): {exc}")

    raise last_error

print("🔌 Attempting DB connection...")

try:
    connect_args = {"sslmode": "require"} if DATABASE_URL.startswith("postgresql") else {}
    engine = create_engine(DATABASE_URL, pool_pre_ping=True, connect_args=connect_args)

    # ✅ Force immediate connection test
    with engine.connect() as conn:
        print("✅ Connected to database successfully!")

except Exception as e:
    print("❌ DB connection failed:", str(e))
    print("⚠️ Falling back to SQLite...")

    fallback_sqlite_url = f"sqlite:///{os.getenv('SQLITE_PATH', './app.db')}"
    engine, DATABASE_URL = _create_sqlite_engine_with_fallback(fallback_sqlite_url)

print("✅ DATABASE_URL:", DATABASE_URL)

if DATABASE_URL.startswith("sqlite"):
    db_file = DATABASE_URL.replace("sqlite:///", "")
    print("✅ FULL DB PATH:", os.path.abspath(db_file))



# --------------------------------------------------
# Session Configuration
# --------------------------------------------------

# Session factory used throughout the app
SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)


# --------------------------------------------------
# Base Class for SQLAlchemy Models
# --------------------------------------------------

# All your ORM models inherit from this
Base = declarative_base()


# --------------------------------------------------
# FastAPI Dependency for DB access
# --------------------------------------------------

def get_db():
    """
    Provides a database session for each request.
    Automatically closes it after use.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
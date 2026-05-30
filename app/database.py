from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from app.config import DATABASE_URL


# --------------------------------------------------
# Engine Configuration
# --------------------------------------------------

engine_kwargs = {}

# ✅ SQLite requires special threading handling
if DATABASE_URL.startswith("sqlite"):
    engine_kwargs["connect_args"] = {"check_same_thread": False}


# Create database engine (works for both SQLite and PostgreSQL)
engine = create_engine(
    DATABASE_URL,
    **engine_kwargs
)


import os

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
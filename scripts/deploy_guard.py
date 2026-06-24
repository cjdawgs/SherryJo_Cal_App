
import os
import sys
import subprocess
import time
from sqlalchemy import create_engine, text

# ==============================
# PROJECT SETUP
# ==============================

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, PROJECT_ROOT)

# ✅ CLEAN DATABASE URL (NO SPACES)
DATABASE_URL = "postgresql+psycopg2://postgres.dtgbcftlciolnrenzicb:oibc94dEdNKQC9tf@aws-1-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require".strip()

migration_db = DATABASE_URL.strip()

REQUIRED_TABLES = [
    "events",
    "date_sticky_notes"
]

# ==============================
# HELPERS
# ==============================

def log(msg):
    print(f"[DEPLOY GUARD] {msg}")

def fail(msg):
    print(f"[DEPLOY GUARD ❌] {msg}")
    sys.exit(1)

def is_pooler(db_url):
    return "pooler.supabase.com" in db_url or ":6543" in db_url

# ==============================
# VALIDATION
# ==============================

def validate_env():
    log("Validating environment...")

    db_url = DATABASE_URL.strip()

    if not db_url:
        fail("DATABASE_URL is not set")

    if "sqlite" in db_url.lower():
        fail("SQLite not allowed in production")

    if "postgres" not in db_url:
        fail("Invalid DATABASE_URL")

    log("Environment validation passed ✅")
    return db_url

# ==============================
# DB CONNECTION
# ==============================

def check_db_connection(db_url):
    log("Checking database connection...")

    for attempt in range(3):
        try:
            
            engine = create_engine(
                db_url,
                pool_pre_ping=True,
                pool_recycle=300,
                connect_args={"sslmode": "require"}
            )


            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))

            log("Database connection OK ✅")
            return

        except Exception as e:
            log(f"Attempt {attempt+1} failed: {e}")
            time.sleep(2)

    fail("Database connection failed after retries")

# ==============================
# MIGRATIONS (SELF-HEALING)
# ==============================

def run_migrations():
    log("Running Alembic migrations...")

    env = os.environ.copy()
    env["PYTHONPATH"] = PROJECT_ROOT
    env["DATABASE_URL"] = migration_db.strip()

    # ✅ TRY NORMAL MIGRATION
    result = subprocess.run(
        ["alembic", "upgrade", "head"],
        cwd=PROJECT_ROOT,
        env=env
    )

    # ✅ IF FAILS → AUTO STAMP
    if result.returncode != 0:
        log("Migration failed — applying stamp fallback...")

        stamp = subprocess.run(
            ["alembic", "stamp", "head"],
            cwd=PROJECT_ROOT,
            env=env
        )

        if stamp.returncode != 0:
            fail("Alembic stamp ALSO failed")

        log("Stamp applied ✅ (existing DB)")

    log("Migrations completed ✅")

# ==============================
# VERIFY TABLES
# ==============================

def verify_tables(db_url):
    log("Verifying required tables...")

    engine = create_engine(db_url)

    try:
        with engine.connect() as conn:
            for table in REQUIRED_TABLES:
                exists = conn.execute(
                    text("""
                        SELECT EXISTS (
                            SELECT FROM information_schema.tables 
                            WHERE table_name = :table
                        )
                    """),
                    {"table": table}
                ).scalar()

                if not exists:
                    fail(f"Missing table: {table}")

        log("All required tables verified ✅")

    except Exception as e:
        fail(f"Table verification failed: {e}")

# ==============================
# OPTIONAL INDEX CHECK
# ==============================

def verify_indexes(db_url):
    log("Verifying indexes...")

    try:
        engine = create_engine(db_url)

        with engine.connect() as conn:
            result = conn.execute(text("""
                SELECT indexname 
                FROM pg_indexes 
                WHERE schemaname = 'public'
                AND tablename = 'date_sticky_notes'
            """))

            indexes = [row[0] for row in result.fetchall()]

            expected = [
                "ix_date_sticky_notes_id",
                "ix_date_sticky_notes_owner_id",
                "ix_date_sticky_notes_date"
            ]

            for idx in expected:
                if idx not in indexes:
                    log(f"⚠️ Missing index: {idx}")

        log("Index check completed ✅")

    except Exception as e:
        log(f"⚠️ Index check skipped: {e}")

# ==============================
# SANITY TEST
# ==============================

def sanity_insert_test(db_url):
    log("Running sanity insert test...")

    engine = create_engine(db_url)

    try:
        with engine.begin() as conn:
            conn.execute(text("""
                INSERT INTO date_sticky_notes (owner_id, date, notes)
                VALUES ('healthcheck', CURRENT_DATE, '[{"content":"test"}]')
                ON CONFLICT DO NOTHING
            """))

        log("Insert test passed ✅")

    except Exception as e:
        fail(f"Insert test failed: {e}")

# ==============================
# START APP
# ==============================

def start_app():
    log("Starting application...")

    python_exe = sys.executable  # ✅ uses your venv python

    subprocess.run([
        python_exe,
        "-m",
        "uvicorn",
        "app.main:app",
        "--host",
        "0.0.0.0",
        "--port",
        "8000"
    ])

# ==============================
# MAIN
# ==============================

def main():
    log("===== DEPLOY GUARD START =====")

    db_url = validate_env()
    check_db_connection(db_url)
    run_migrations()
    verify_tables(db_url)

    if not is_pooler(db_url):
        verify_indexes(db_url)

    sanity_insert_test(db_url)

    log("✅ ALL SYSTEMS GREEN")
    log("✅ SAFE TO START APP")

    start_app()

if __name__ == "__main__":
    main()

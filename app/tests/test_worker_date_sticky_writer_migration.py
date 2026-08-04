from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "alembic" / "versions" / "t973n44fff77_add_worker_date_sticky_writer.py"
SPEC = spec_from_file_location("worker_date_sticky_writer_migration", MIGRATION_PATH)
MIGRATION = module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MIGRATION)


def test_worker_date_sticky_writer_is_replay_safe_and_owner_scoped():
    statements = "\n".join(MIGRATION.upgrade_statements()).upper()

    assert "PRIMARY KEY (OWNER_ID, IDEMPOTENCY_KEY)" in statements
    assert "WORKER_APP_USER_ID()" in statements
    assert "FOR INSERT TO WORKER_CALENDAR_READER" in statements
    assert "FOR UPDATE TO WORKER_CALENDAR_READER" in statements
    assert "FOR DELETE TO WORKER_CALENDAR_READER" in statements
    assert "GRANT INSERT (OWNER_ID, DATE, STICKY_NOTES, UPDATED_AT)" in statements
    assert "GRANT UPDATE (STICKY_NOTES, UPDATED_AT)" in statements
    assert "GRANT DELETE ON TABLE PUBLIC.DATE_STICKY_NOTES" in statements
    assert "GRANT ALL" not in statements
    assert "OAUTH_ACCOUNTS" not in statements
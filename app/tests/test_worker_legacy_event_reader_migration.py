import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "alembic" / "versions" / "r971l22ddd55_add_worker_legacy_event_reader.py"
MIGRATION_SPEC = importlib.util.spec_from_file_location("worker_legacy_event_reader_migration", MIGRATION_PATH)
assert MIGRATION_SPEC and MIGRATION_SPEC.loader
MIGRATION = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION)


def test_worker_legacy_event_reader_adds_only_missing_read_column():
    statements = "\n".join(MIGRATION.upgrade_statements())

    assert 'GRANT SELECT ("status") ON TABLE public.events TO worker_calendar_reader' in statements
    assert "INSERT" not in statements
    assert "UPDATE" not in statements
    assert "DELETE" not in statements
    assert "GRANT ALL" not in statements
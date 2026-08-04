import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "alembic" / "versions" / "n967h88fff11_add_worker_note_reader.py"
MIGRATION_SPEC = importlib.util.spec_from_file_location("worker_note_reader_migration", MIGRATION_PATH)
assert MIGRATION_SPEC and MIGRATION_SPEC.loader
MIGRATION = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION)


def test_worker_note_reader_is_event_owner_scoped_and_read_only():
    statements = "\n".join(MIGRATION.upgrade_statements())

    assert "ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY" in statements
    assert "FOR SELECT" in statements
    assert "TO worker_calendar_reader" in statements
    assert "events.id = notes.event_id" in statements
    assert "events.owner_id = public.worker_app_user_id()" in statements
    assert "GRANT SELECT" in statements
    assert "INSERT" not in statements
    assert "UPDATE" not in statements
    assert "DELETE" not in statements


def test_worker_note_reader_grants_only_public_response_columns():
    statements = "\n".join(MIGRATION.upgrade_statements())

    for column in MIGRATION.NOTE_READ_COLUMNS:
        assert f'"{column}"' in statements
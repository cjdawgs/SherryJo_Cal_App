import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "alembic" / "versions" / "q970k11ccc44_add_worker_current_user_reader.py"
MIGRATION_SPEC = importlib.util.spec_from_file_location("worker_current_user_reader_migration", MIGRATION_PATH)
assert MIGRATION_SPEC and MIGRATION_SPEC.loader
MIGRATION = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION)


def test_worker_current_user_reader_is_owner_scoped_and_read_only():
    statements = "\n".join(MIGRATION.upgrade_statements())

    assert "ALTER TABLE public.users ENABLE ROW LEVEL SECURITY" in statements
    assert "FOR SELECT" in statements
    assert "TO worker_calendar_reader" in statements
    assert "id = public.worker_app_user_id()" in statements
    assert "GRANT SELECT" in statements
    assert "INSERT" not in statements
    assert "UPDATE" not in statements
    assert "DELETE" not in statements


def test_worker_current_user_reader_excludes_credentials():
    statements = "\n".join(MIGRATION.upgrade_statements()).lower()

    for column in MIGRATION.CURRENT_USER_READ_COLUMNS:
        assert f'"{column}"' in statements
    assert "password" not in statements
    assert "token" not in statements
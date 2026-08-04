import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "alembic" / "versions" / "m966g77eee00_add_worker_task_reader.py"
MIGRATION_SPEC = importlib.util.spec_from_file_location("worker_task_reader_migration", MIGRATION_PATH)
assert MIGRATION_SPEC and MIGRATION_SPEC.loader
MIGRATION = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION)


def test_worker_task_reader_is_owner_scoped_and_read_only():
    statements = "\n".join(MIGRATION.upgrade_statements())

    assert "ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY" in statements
    assert "FOR SELECT" in statements
    assert "TO worker_calendar_reader" in statements
    assert "owner_id = public.worker_app_user_id()" in statements
    assert "GRANT SELECT" in statements
    assert "INSERT" not in statements
    assert "UPDATE" not in statements
    assert "DELETE" not in statements
    assert "ALTER TABLE public.tasks DISABLE ROW LEVEL SECURITY" not in statements


def test_worker_task_reader_grants_only_public_response_columns():
    statements = "\n".join(MIGRATION.upgrade_statements())

    for column in MIGRATION.TASK_READ_COLUMNS:
        assert f'"{column}"' in statements


def test_worker_task_reader_downgrade_removes_policy_and_grant():
    statements = "\n".join(MIGRATION.downgrade_statements())

    assert "DROP POLICY IF EXISTS worker_task_reader_select" in statements
    assert "REVOKE ALL ON TABLE public.tasks FROM worker_calendar_reader" in statements
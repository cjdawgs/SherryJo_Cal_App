from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

PATH = Path(__file__).resolve().parents[2] / "alembic/versions/y978s99kkk22_add_worker_note_task_writers.py"
SPEC = spec_from_file_location("worker_note_task_writers", PATH)
MIGRATION = module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MIGRATION)


def test_note_task_writers_are_owner_scoped_and_least_privilege():
    statements = "\n".join(MIGRATION.upgrade_statements()).upper()
    assert statements.count("WORKER_APP_USER_ID()") >= 4
    assert "GRANT INSERT (ID, DATE, CONTENT, COLOR, X, Y, EVENT_ID)" in statements
    assert "GRANT UPDATE (CONTENT)" in statements
    assert "GRANT INSERT (OWNER_ID, TITLE, DESCRIPTION, COMPLETED, CREATED_AT)" in statements
    assert "GRANT DELETE" not in statements
    assert "GRANT ALL" not in statements
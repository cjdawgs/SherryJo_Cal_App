from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

PATH = Path(__file__).resolve().parents[2] / "alembic/versions/w976q77iii00_add_worker_event_creator.py"
SPEC = spec_from_file_location("worker_event_creator", PATH)
MIGRATION = module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MIGRATION)


def test_worker_event_creator_is_insert_only_and_owner_scoped():
    statements = "\n".join(MIGRATION.upgrade_statements()).upper()
    assert "WORKER_APP_USER_ID()" in statements
    assert "FOR INSERT TO WORKER_CALENDAR_READER" in statements
    assert "GRANT INSERT (OWNER_ID, TITLE" in statements
    assert "GRANT UPDATE" not in statements
    assert "GRANT DELETE" not in statements
    assert "GRANT ALL" not in statements
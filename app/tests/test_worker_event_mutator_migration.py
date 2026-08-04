from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

PATH = Path(__file__).resolve().parents[2] / "alembic/versions/x977r88jjj11_add_worker_event_mutator.py"
SPEC = spec_from_file_location("worker_event_mutator", PATH)
MIGRATION = module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MIGRATION)


def test_worker_event_mutator_is_owner_scoped_and_column_limited():
    statements = "\n".join(MIGRATION.upgrade_statements()).upper()
    assert statements.count("WORKER_APP_USER_ID()") >= 3
    assert "FOR UPDATE TO WORKER_CALENDAR_READER" in statements
    assert "FOR DELETE TO WORKER_CALENDAR_READER" in statements
    assert "GRANT UPDATE (TITLE, DESCRIPTION, START_TIME" in statements
    assert "GRANT DELETE ON TABLE PUBLIC.EVENTS" in statements
    assert "GRANT DELETE ON TABLE PUBLIC.NOTES" in statements
    assert "GRANT ALL" not in statements
    assert "OAUTH_ACCOUNTS" not in statements
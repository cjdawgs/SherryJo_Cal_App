from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "alembic" / "versions" / "u974o55ggg88_add_worker_tag_color_writer.py"
SPEC = spec_from_file_location("worker_tag_color_writer_migration", MIGRATION_PATH)
MIGRATION = module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MIGRATION)


def test_worker_tag_color_writer_is_least_privilege_and_owner_scoped():
    statements = "\n".join(MIGRATION.upgrade_statements()).upper()

    assert "WORKER_APP_USER_ID()" in statements
    assert "FOR INSERT TO WORKER_CALENDAR_READER" in statements
    assert "FOR UPDATE TO WORKER_CALENDAR_READER" in statements
    assert "GRANT INSERT (OWNER_ID, TAG_KEY, LABEL, COLOR, ENABLED, UPDATED_AT)" in statements
    assert "GRANT UPDATE (LABEL, COLOR, ENABLED, UPDATED_AT)" in statements
    assert "GRANT DELETE" not in statements
    assert "GRANT ALL" not in statements
    assert "OAUTH_ACCOUNTS" not in statements
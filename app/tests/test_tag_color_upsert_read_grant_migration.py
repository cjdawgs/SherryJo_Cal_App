from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "alembic" / "versions" / "v975p66hhh99_add_tag_color_upsert_read_grant.py"
SPEC = spec_from_file_location("tag_color_upsert_read_grant_migration", MIGRATION_PATH)
MIGRATION = module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MIGRATION)


def test_tag_color_upsert_read_grant_is_column_scoped():
    statements = "\n".join(MIGRATION.upgrade_statements()).upper()

    assert "GRANT SELECT (UPDATED_AT)" in statements
    assert "GRANT SELECT ON TABLE" not in statements
    assert "GRANT ALL" not in statements
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "alembic" / "versions" / "ag987a77ttt11_add_worker_account_reads.py"
SPEC = spec_from_file_location("worker_account_reads_migration", MIGRATION_PATH)
MIGRATION = module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MIGRATION)


def test_rollup_grant_is_read_only_and_column_scoped():
    statements = "\n".join(MIGRATION.upgrade_statements()).lower()

    assert "grant select (" in statements
    assert "sync_efficiency_daily_rollups" in statements
    assert "grant insert" not in statements
    assert "grant update" not in statements
    assert "grant delete" not in statements
    assert "created_at" not in MIGRATION.ROLLUP_COLUMNS
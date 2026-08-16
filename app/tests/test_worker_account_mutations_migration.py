from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "alembic" / "versions" / "ah988b88uuu22_add_worker_account_mutations.py"
SPEC = spec_from_file_location("worker_account_mutations_migration", MIGRATION_PATH)
MIGRATION = module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MIGRATION)


def test_account_mutation_grants_are_owner_scoped_and_column_limited():
    statements = "\n".join(MIGRATION.upgrade_statements()).lower()

    assert "grant update (is_primary, sync_enabled, color, sync_frequency_minutes, sync_range_days)" in statements
    assert "for delete" in statements
    assert "user_id = public.worker_app_user_id()" in statements
    assert "access_token" not in statements
    assert "refresh_token" not in statements
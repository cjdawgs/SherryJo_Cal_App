from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "alembic" / "versions" / "aj990d00www44_add_worker_tv_state.py"
SPEC = spec_from_file_location("worker_tv_state_migration", MIGRATION_PATH)
MIGRATION = module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MIGRATION)


def test_tv_state_is_owner_scoped_without_delete_access():
    statements = "\n".join(MIGRATION.upgrade_statements()).lower()

    assert "user_id integer primary key" in statements
    assert "selected_date date" in statements
    assert "enable row level security" in statements
    assert "force row level security" in statements
    assert "user_id = public.worker_app_user_id()" in statements
    assert "grant select, insert, update" in statements
    assert "grant delete" not in statements
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "alembic" / "versions" / "ai989c99vvv33_add_worker_tv_pairing.py"
SPEC = spec_from_file_location("worker_tv_pairing_migration", MIGRATION_PATH)
MIGRATION = module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MIGRATION)


def test_tv_pairing_uses_atomic_functions_without_direct_worker_table_access():
    statements = "\n".join(MIGRATION.upgrade_statements()).lower()

    assert "enable row level security" in statements
    assert "force row level security" in statements
    assert "security definer" in statements
    assert "worker_app_user_id()" in statements
    assert "consumed_at is null" in statements
    assert "expires_at > now()" in statements
    assert "grant execute on function public.worker_create_tv_pairing_code" in statements
    assert "grant execute on function public.worker_redeem_tv_pairing_code" in statements
    assert "grant execute on function public.worker_auto_redeem_tv_pairing_code" in statements
    assert "for update skip locked" in statements
    assert "grant select" not in statements
    assert "grant insert" not in statements
    assert "grant update" not in statements
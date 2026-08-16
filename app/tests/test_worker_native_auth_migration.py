from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "alembic" / "versions" / "af986z66sss00_add_worker_native_auth.py"
SPEC = spec_from_file_location("worker_native_auth_migration", MIGRATION_PATH)
MIGRATION = module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MIGRATION)


def test_native_auth_functions_are_narrow_security_definers():
    statements = "\n".join(MIGRATION.upgrade_statements()).lower()

    assert statements.count("security definer") == 2
    assert "set search_path = ''" in statements
    assert "revoke all on function public.worker_find_login_user" in statements
    assert "revoke all on function public.worker_register_user" in statements
    assert f"to {MIGRATION.WORKER_ROLE}" in statements
    assert "grant select" not in statements
    assert "grant insert" not in statements


def test_native_registration_accepts_only_argon2id_and_known_roles():
    statements = "\n".join(MIGRATION.upgrade_statements()).lower()

    assert "p_hashed_password not like '$argon2id$%'" in statements
    assert "not in ('admin', 'staff')" in statements
    assert "between 1 and 100" in statements
    assert "between 3 and 320" in statements
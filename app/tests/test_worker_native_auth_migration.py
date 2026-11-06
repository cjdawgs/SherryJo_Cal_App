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


def test_shared_master_admin_code_uses_restricted_hash_functions():
    migration_path = ROOT / "alembic" / "versions" / "ax002w88kkk00_add_shared_master_admin_code.py"
    spec = spec_from_file_location("shared_master_admin_code_migration", migration_path)
    migration = module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(migration)
    statements = "\n".join(migration.upgrade_statements()).lower()

    assert "secret_hash varchar(512) not null" in statements
    assert statements.count("security definer") == 2
    assert "set search_path = ''" in statements
    assert "revoke all on function public.worker_get_master_admin_code_hash()" in statements
    assert "revoke all on function public.worker_set_master_admin_code_hash(text)" in statements
    assert "revoke all on function public.worker_get_master_admin_code_hash() from %i" in statements
    assert "revoke all on function public.worker_set_master_admin_code_hash(text) from %i" in statements
    assert f"to {migration.WORKER_ROLE.lower()}" in statements
    assert "grant select" not in statements
    assert "grant insert" not in statements
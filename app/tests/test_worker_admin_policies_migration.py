import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / "alembic" / "versions" / "am993g33zzz77_add_worker_admin_policies.py"
SPEC = importlib.util.spec_from_file_location("worker_admin_policies_migration", PATH)
MIGRATION = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MIGRATION)


def test_admin_access_requires_transaction_identity_with_admin_role():
    statements = "\n".join(MIGRATION.upgrade_statements()).lower()

    assert "security definer" in statements
    assert "id = public.worker_app_user_id()" in statements
    assert "lower(role) = 'admin'" in statements
    assert "revoke all on function public.worker_app_is_admin() from public" in statements
    assert "grant usage on sequence public.users_id_seq" in statements
    assert "all sequences in schema" not in statements
    for table in MIGRATION.TABLES:
        assert f"create policy worker_admin_all on public.{table}" in statements
        assert "using (public.worker_app_is_admin())" in statements
        assert "with check (public.worker_app_is_admin())" in statements
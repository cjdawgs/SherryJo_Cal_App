from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "alembic" / "versions" / "ae985y55rrr99_add_worker_scheduled_sync.py"
SPEC = spec_from_file_location("worker_scheduled_sync_migration", MIGRATION_PATH)
MIGRATION = module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MIGRATION)


def test_due_account_claim_is_bounded_atomic_and_excludes_terminal_work():
    statements = "\n".join(MIGRATION.upgrade_statements()).lower()

    assert "security definer" in statements
    assert "for update skip locked" in statements
    assert "least(greatest(p_limit, 1), 50)" in statements
    assert "sync_claimed_until" in statements
    assert "ledger.status = 'dead_letter'" in statements
    assert "('google', 'microsoft', 'apple')" in statements
    assert "lower(account.provider) = 'apple'" in statements
    assert "mins => 240" in statements
    assert "revoke all on function public.worker_claim_due_sync_accounts" in statements
    assert f"to {MIGRATION.WORKER_ROLE}" in statements


def test_worker_ledger_access_remains_scoped_to_transaction_user_identity():
    statements = "\n".join(MIGRATION.upgrade_statements()).lower()

    for operation in ("select", "insert", "update"):
        assert f"for {operation} to {MIGRATION.WORKER_ROLE}" in statements
    assert "owner_user_id = public.worker_app_user_id()" in statements
    assert "grant select, insert, update on table public.sync_operation_ledger" in statements
    assert "grant execute on function public.worker_claim_due_sync_accounts" in statements
    assert "grant select on table public.users" not in statements
    assert "worker_run_scheduled_maintenance" in statements
    assert "revoke all on function public.worker_run_scheduled_maintenance" in statements


def test_migration_extends_only_columns_needed_by_provider_sync():
    statements = "\n".join(MIGRATION.upgrade_statements()).lower()

    assert 'grant insert ("externalid", external_ids)' in statements
    assert 'grant update ("externalid", external_ids, source, account_email, status)' in statements
    assert "sync_token" in statements
    assert "last_sync_success" in statements
    assert "grant delete on table public.oauth_accounts" not in statements
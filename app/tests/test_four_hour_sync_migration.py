from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


def test_due_claim_uses_utc_slots_and_preserves_longer_intervals():
    path = Path(__file__).resolve().parents[2] / "alembic" / "versions" / "aw001v77jjj99_four_hour_sync_cadence.py"
    spec = spec_from_file_location("four_hour_sync_migration", path)
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    sql = module.claim_function_sql(True).lower()
    assert "for update skip locked" in sql
    assert "ledger.status = 'dead_letter'" in sql
    assert "14400" in sql
    assert "greatest(coalesce(account.sync_frequency_minutes, 5), 240)" in sql
    assert "worker_claim_due_sync_accounts" in module.claim_function_sql(False)

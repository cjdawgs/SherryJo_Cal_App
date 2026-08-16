"""Regression coverage for pre-provisioned sync ledger reconciliation."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "alembic" / "versions" / "ab982v22ooo66_add_sync_operation_ledger.py"


def test_sync_ledger_upgrade_reconciles_existing_table():
    source = MIGRATION_PATH.read_text(encoding="utf-8")

    assert 'has_table("sync_operation_ledger")' in source
    assert "ALTER COLUMN attempt_count SET DEFAULT 1" in source
    assert source.count("CREATE INDEX IF NOT EXISTS ix_sync_operation_ledger_") == 4
"""Regression coverage for Worker write receipt grants."""

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "alembic" / "versions" / "an994h44aaa88_restore_worker_write_receipt_grants.py"
MIGRATION_SPEC = importlib.util.spec_from_file_location("worker_write_receipt_grants", MIGRATION_PATH)
assert MIGRATION_SPEC and MIGRATION_SPEC.loader
MIGRATION = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION)


def test_worker_write_receipt_grants_are_least_privilege():
    statements = "\n".join(MIGRATION.upgrade_statements()).upper()

    assert "GRANT SELECT (OWNER_ID, IDEMPOTENCY_KEY, OPERATION, REQUEST_HASH, RESPONSE_BODY)" in statements
    assert "GRANT INSERT (OWNER_ID, IDEMPOTENCY_KEY, OPERATION, REQUEST_HASH, RESPONSE_BODY)" in statements
    assert "GRANT UPDATE" not in statements
    assert "GRANT DELETE" not in statements
    assert "GRANT ALL" not in statements
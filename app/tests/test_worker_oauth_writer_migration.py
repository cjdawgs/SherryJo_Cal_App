"""Regression coverage for the Worker OAuth writer migration."""

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "alembic" / "versions" / "bb981v22nnn55_add_worker_oauth_writer.py"
MIGRATION_SPEC = importlib.util.spec_from_file_location("worker_oauth_writer_migration", MIGRATION_PATH)
assert MIGRATION_SPEC and MIGRATION_SPEC.loader
MIGRATION = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION)


def test_worker_oauth_policies_are_created_idempotently():
    statements = "\n".join(MIGRATION.upgrade_statements()).lower()

    for policy_name in (
        "worker_oauth_reader",
        "worker_oauth_writer_insert",
        "worker_oauth_writer_update",
    ):
        assert f"policyname = '{policy_name}'" in statements
        assert f"create policy {policy_name}" in statements

    assert statements.count("if not exists (") == 3
import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / "alembic" / "versions" / "al992f22yyy66_add_worker_websocket_tickets.py"
SPEC = importlib.util.spec_from_file_location("worker_websocket_ticket_migration", PATH)
MIGRATION = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MIGRATION)


def test_websocket_ticket_functions_are_bounded_atomic_and_worker_only():
    statements = "\n".join(MIGRATION.upgrade_statements()).lower()

    assert "security definer" in statements
    assert "p_expires_at > now() + interval '2 minutes'" in statements
    assert "consumed_at is null" in statements
    assert "returning ticket.user_id" in statements
    assert "revoke all on function public.worker_issue_websocket_ticket" in statements
    assert "grant execute on function public.worker_consume_websocket_ticket" in statements
    assert "worker_calendar_reader" in statements
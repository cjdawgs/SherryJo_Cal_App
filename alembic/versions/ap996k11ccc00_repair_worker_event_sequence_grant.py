"""repair_worker_event_sequence_grant

Revision ID: ap996k11ccc00
Revises: ao995i55bbb99
Create Date: 2026-09-10 00:00:00.000000
"""

from alembic import op


revision = "ap996k11ccc00"
down_revision = "ao995i55bbb99"
branch_labels = None
depends_on = None

WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        f"GRANT USAGE ON SEQUENCE public.events_id_seq TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE USAGE ON SEQUENCE public.events_id_seq FROM {WORKER_ROLE}",
    )


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements():
            op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements():
            op.execute(statement)

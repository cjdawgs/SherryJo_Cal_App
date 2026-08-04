"""add_worker_legacy_event_reader

Revision ID: r971l22ddd55
Revises: q970k11ccc44
Create Date: 2026-08-04 00:00:00.000000

Adds the one event column not already granted for the Worker-native legacy
event list. Existing event and note RLS policies continue to enforce ownership.
"""

from alembic import op


revision = "r971l22ddd55"
down_revision = "q970k11ccc44"
branch_labels = None
depends_on = None


WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (f'GRANT SELECT ("status") ON TABLE public.events TO {WORKER_ROLE}',)


def downgrade_statements() -> tuple[str, ...]:
    return (f'REVOKE SELECT ("status") ON TABLE public.events FROM {WORKER_ROLE}',)


def upgrade() -> None:
    if not _is_postgres():
        return
    for statement in upgrade_statements():
        op.execute(statement)


def downgrade() -> None:
    if not _is_postgres():
        return
    for statement in downgrade_statements():
        op.execute(statement)
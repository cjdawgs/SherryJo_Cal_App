"""add_worker_reader_predicate_grants

Revision ID: s972m33eee66
Revises: r971l22ddd55
Create Date: 2026-08-04 00:00:00.000000

Grants the owner predicate columns required by Worker-native reads.
"""

from alembic import op


revision = "s972m33eee66"
down_revision = "r971l22ddd55"
branch_labels = None
depends_on = None


WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        f"GRANT SELECT (owner_id) ON TABLE public.date_sticky_notes TO {WORKER_ROLE}",
        f"GRANT SELECT (owner_id) ON TABLE public.event_tag_color_settings TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE SELECT (owner_id) ON TABLE public.date_sticky_notes FROM {WORKER_ROLE}",
        f"REVOKE SELECT (owner_id) ON TABLE public.event_tag_color_settings FROM {WORKER_ROLE}",
    )


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
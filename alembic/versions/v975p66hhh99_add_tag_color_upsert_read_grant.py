"""add_tag_color_upsert_read_grant

Revision ID: v975p66hhh99
Revises: u974o55ggg88
Create Date: 2026-08-04 00:00:00.000000

Grants the target-column read privilege PostgreSQL requires for tag-color upserts.
"""

from alembic import op


revision = "v975p66hhh99"
down_revision = "u974o55ggg88"
branch_labels = None
depends_on = None


WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        f"GRANT SELECT (updated_at) ON TABLE public.event_tag_color_settings TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE SELECT (updated_at) ON TABLE public.event_tag_color_settings FROM {WORKER_ROLE}",
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
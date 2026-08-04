"""add_worker_event_creator

Revision ID: w976q77iii00
Revises: v975p66hhh99
Create Date: 2026-08-04 00:00:00.000000
"""

from alembic import op

revision = "w976q77iii00"
down_revision = "v975p66hhh99"
branch_labels = None
depends_on = None
WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        f"""CREATE POLICY worker_event_creator_insert ON public.events
            FOR INSERT TO {WORKER_ROLE}
            WITH CHECK (owner_id = public.worker_app_user_id())""",
        f"GRANT INSERT (owner_id, title, description, start_time, end_time, recurrence, source, account_email, color, color_enabled, tags, sticky_note, sticky_notes, status, created_at, updated_at) ON TABLE public.events TO {WORKER_ROLE}",
        f"GRANT USAGE ON SEQUENCE public.events_id_seq TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE USAGE ON SEQUENCE public.events_id_seq FROM {WORKER_ROLE}",
        f"REVOKE INSERT ON TABLE public.events FROM {WORKER_ROLE}",
        "DROP POLICY IF EXISTS worker_event_creator_insert ON public.events",
    )


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements(): op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements(): op.execute(statement)
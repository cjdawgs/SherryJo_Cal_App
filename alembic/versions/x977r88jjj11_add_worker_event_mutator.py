"""add_worker_event_mutator

Revision ID: x977r88jjj11
Revises: w976q77iii00
Create Date: 2026-08-04 00:00:00.000000
"""

from alembic import op

revision = "x977r88jjj11"
down_revision = "w976q77iii00"
branch_labels = None
depends_on = None
WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        f"""CREATE POLICY worker_event_mutator_update ON public.events
            FOR UPDATE TO {WORKER_ROLE}
            USING (owner_id = public.worker_app_user_id())
            WITH CHECK (owner_id = public.worker_app_user_id())""",
        f"""CREATE POLICY worker_event_mutator_delete ON public.events
            FOR DELETE TO {WORKER_ROLE}
            USING (owner_id = public.worker_app_user_id())""",
        f"""CREATE POLICY worker_event_note_delete ON public.notes
            FOR DELETE TO {WORKER_ROLE}
            USING (EXISTS (
                SELECT 1 FROM public.events
                WHERE events.id = notes.event_id
                  AND events.owner_id = public.worker_app_user_id()
            ))""",
        f"GRANT UPDATE (title, description, start_time, end_time, recurrence, color, color_enabled, tags, sticky_note, sticky_notes, updated_at) ON TABLE public.events TO {WORKER_ROLE}",
        f"GRANT DELETE ON TABLE public.events TO {WORKER_ROLE}",
        f"GRANT DELETE ON TABLE public.notes TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE DELETE ON TABLE public.notes FROM {WORKER_ROLE}",
        f"REVOKE UPDATE, DELETE ON TABLE public.events FROM {WORKER_ROLE}",
        "DROP POLICY IF EXISTS worker_event_note_delete ON public.notes",
        "DROP POLICY IF EXISTS worker_event_mutator_delete ON public.events",
        "DROP POLICY IF EXISTS worker_event_mutator_update ON public.events",
    )


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements(): op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements(): op.execute(statement)
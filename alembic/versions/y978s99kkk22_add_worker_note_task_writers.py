"""add_worker_note_task_writers

Revision ID: y978s99kkk22
Revises: x977r88jjj11
Create Date: 2026-08-04 00:00:00.000000
"""

from alembic import op

revision = "y978s99kkk22"
down_revision = "x977r88jjj11"
branch_labels = None
depends_on = None
WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        f"""CREATE POLICY worker_note_writer_insert ON public.notes
            FOR INSERT TO {WORKER_ROLE}
            WITH CHECK (EXISTS (SELECT 1 FROM public.events
                WHERE events.id = notes.event_id
                  AND events.owner_id = public.worker_app_user_id()))""",
        f"""CREATE POLICY worker_note_writer_update ON public.notes
            FOR UPDATE TO {WORKER_ROLE}
            USING (EXISTS (SELECT 1 FROM public.events
                WHERE events.id = notes.event_id
                  AND events.owner_id = public.worker_app_user_id()))
            WITH CHECK (EXISTS (SELECT 1 FROM public.events
                WHERE events.id = notes.event_id
                  AND events.owner_id = public.worker_app_user_id()))""",
        f"""CREATE POLICY worker_task_writer_insert ON public.tasks
            FOR INSERT TO {WORKER_ROLE}
            WITH CHECK (owner_id = public.worker_app_user_id())""",
        f"GRANT INSERT (id, date, content, color, x, y, event_id) ON TABLE public.notes TO {WORKER_ROLE}",
        f"GRANT UPDATE (content) ON TABLE public.notes TO {WORKER_ROLE}",
        f"GRANT INSERT (owner_id, title, description, completed, created_at) ON TABLE public.tasks TO {WORKER_ROLE}",
        f"GRANT USAGE ON SEQUENCE public.tasks_id_seq TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE USAGE ON SEQUENCE public.tasks_id_seq FROM {WORKER_ROLE}",
        f"REVOKE INSERT ON TABLE public.tasks FROM {WORKER_ROLE}",
        f"REVOKE INSERT, UPDATE ON TABLE public.notes FROM {WORKER_ROLE}",
        "DROP POLICY IF EXISTS worker_task_writer_insert ON public.tasks",
        "DROP POLICY IF EXISTS worker_note_writer_update ON public.notes",
        "DROP POLICY IF EXISTS worker_note_writer_insert ON public.notes",
    )


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements(): op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements(): op.execute(statement)
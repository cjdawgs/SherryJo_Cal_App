"""add_worker_note_reader

Revision ID: n967h88fff11
Revises: m966g77eee00
Create Date: 2026-08-04 00:00:00.000000

Adds the event-owner-scoped RLS policy and column-level grant required for the
Worker-native note list route. The Worker role remains read-only.
"""

from alembic import op


revision = "n967h88fff11"
down_revision = "m966g77eee00"
branch_labels = None
depends_on = None


WORKER_ROLE = "worker_calendar_reader"
NOTE_READ_COLUMNS = (
    "id",
    "date",
    "content",
    "color",
    "x",
    "y",
    "event_id",
)


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    quoted_columns = ", ".join(f'"{column}"' for column in NOTE_READ_COLUMNS)
    return (
        "ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY",
        "DROP POLICY IF EXISTS worker_note_reader_select ON public.notes",
        f"""
        CREATE POLICY worker_note_reader_select ON public.notes
            FOR SELECT
            TO {WORKER_ROLE}
            USING (
                EXISTS (
                    SELECT 1
                    FROM public.events
                    WHERE events.id = notes.event_id
                      AND events.owner_id = public.worker_app_user_id()
                )
            )
        """,
        f"GRANT SELECT ({quoted_columns}) ON TABLE public.notes TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        "DROP POLICY IF EXISTS worker_note_reader_select ON public.notes",
        f"REVOKE ALL ON TABLE public.notes FROM {WORKER_ROLE}",
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
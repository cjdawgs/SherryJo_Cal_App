"""add_worker_date_sticky_reader

Revision ID: o968i99aaa22
Revises: n967h88fff11
Create Date: 2026-08-04 00:00:00.000000

Adds owner-scoped, read-only access for Worker-native date-sticky reads.
"""

from alembic import op


revision = "o968i99aaa22"
down_revision = "n967h88fff11"
branch_labels = None
depends_on = None


WORKER_ROLE = "worker_calendar_reader"
DATE_STICKY_READ_COLUMNS = ("id", "date", "sticky_notes", "updated_at")


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    quoted_columns = ", ".join(f'"{column}"' for column in DATE_STICKY_READ_COLUMNS)
    return (
        "ALTER TABLE public.date_sticky_notes ENABLE ROW LEVEL SECURITY",
        "DROP POLICY IF EXISTS worker_date_sticky_reader_select ON public.date_sticky_notes",
        f"""
        CREATE POLICY worker_date_sticky_reader_select ON public.date_sticky_notes
            FOR SELECT
            TO {WORKER_ROLE}
            USING (owner_id = public.worker_app_user_id())
        """,
        f"GRANT SELECT ({quoted_columns}) ON TABLE public.date_sticky_notes TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        "DROP POLICY IF EXISTS worker_date_sticky_reader_select ON public.date_sticky_notes",
        f"REVOKE ALL ON TABLE public.date_sticky_notes FROM {WORKER_ROLE}",
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
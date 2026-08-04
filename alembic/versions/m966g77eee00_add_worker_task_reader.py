"""add_worker_task_reader

Revision ID: m966g77eee00
Revises: l965f66ccc99
Create Date: 2026-08-04 00:00:00.000000

Adds the owner-scoped RLS policy and column-level grant required for the
Worker-native task list route. The Worker role remains read-only.
"""

from alembic import op


revision = "m966g77eee00"
down_revision = "l965f66ccc99"
branch_labels = None
depends_on = None


WORKER_ROLE = "worker_calendar_reader"
TASK_READ_COLUMNS = (
    "id",
    "title",
    "description",
    "completed",
    "owner_id",
    "created_at",
)


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    quoted_columns = ", ".join(f'"{column}"' for column in TASK_READ_COLUMNS)
    return (
        "ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY",
        "DROP POLICY IF EXISTS worker_task_reader_select ON public.tasks",
        f"""
        CREATE POLICY worker_task_reader_select ON public.tasks
            FOR SELECT
            TO {WORKER_ROLE}
            USING (owner_id = public.worker_app_user_id())
        """,
        f"GRANT SELECT ({quoted_columns}) ON TABLE public.tasks TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        "DROP POLICY IF EXISTS worker_task_reader_select ON public.tasks",
        f"REVOKE ALL ON TABLE public.tasks FROM {WORKER_ROLE}",
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
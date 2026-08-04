"""add_worker_current_user_reader

Revision ID: q970k11ccc44
Revises: p969j00bbb33
Create Date: 2026-08-04 00:00:00.000000

Adds an owner-scoped, credential-free projection for Worker-native /users/me.
"""

from alembic import op


revision = "q970k11ccc44"
down_revision = "p969j00bbb33"
branch_labels = None
depends_on = None


WORKER_ROLE = "worker_calendar_reader"
CURRENT_USER_READ_COLUMNS = ("id", "email", "role")


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    quoted_columns = ", ".join(f'"{column}"' for column in CURRENT_USER_READ_COLUMNS)
    return (
        "ALTER TABLE public.users ENABLE ROW LEVEL SECURITY",
        "DROP POLICY IF EXISTS worker_current_user_reader_select ON public.users",
        f"""
        CREATE POLICY worker_current_user_reader_select ON public.users
            FOR SELECT
            TO {WORKER_ROLE}
            USING (id = public.worker_app_user_id())
        """,
        f"GRANT SELECT ({quoted_columns}) ON TABLE public.users TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        "DROP POLICY IF EXISTS worker_current_user_reader_select ON public.users",
        f"REVOKE ALL ON TABLE public.users FROM {WORKER_ROLE}",
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
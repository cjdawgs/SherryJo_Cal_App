"""add worker account mutations

Revision ID: ah988b88uuu22
Revises: ag987a77ttt11
Create Date: 2026-08-16 03:00:00.000000
"""

from alembic import op


revision = "ah988b88uuu22"
down_revision = "ag987a77ttt11"
branch_labels = None
depends_on = None

WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        f"""GRANT UPDATE (is_primary, sync_enabled, color, sync_frequency_minutes, sync_range_days)
            ON TABLE public.oauth_accounts TO {WORKER_ROLE}""",
        f"""CREATE POLICY worker_oauth_writer_delete ON public.oauth_accounts
            FOR DELETE TO {WORKER_ROLE}
            USING (user_id = public.worker_app_user_id())""",
        f"GRANT DELETE ON TABLE public.oauth_accounts TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE DELETE ON TABLE public.oauth_accounts FROM {WORKER_ROLE}",
        "DROP POLICY IF EXISTS worker_oauth_writer_delete ON public.oauth_accounts",
        f"REVOKE UPDATE (is_primary, sync_enabled, color, sync_frequency_minutes, sync_range_days) ON TABLE public.oauth_accounts FROM {WORKER_ROLE}",
    )


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements():
            op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements():
            op.execute(statement)
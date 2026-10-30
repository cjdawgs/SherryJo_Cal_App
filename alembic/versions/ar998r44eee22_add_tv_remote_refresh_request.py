"""Add durable TV remote refresh requests."""

from alembic import op


revision = "ar998r44eee22"
down_revision = "aq997l22ddd11"
branch_labels = None
depends_on = None

WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        "ALTER TABLE public.tv_user_state ADD COLUMN remote_refresh_requested_at timestamp with time zone, ADD COLUMN remote_refresh_device_id varchar(64)",
        f"""CREATE POLICY worker_tv_state_admin ON public.tv_user_state
            FOR ALL TO {WORKER_ROLE}
            USING (public.worker_app_is_admin())
            WITH CHECK (public.worker_app_is_admin())""",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        "DROP POLICY IF EXISTS worker_tv_state_admin ON public.tv_user_state",
        "ALTER TABLE public.tv_user_state DROP COLUMN IF EXISTS remote_refresh_device_id, DROP COLUMN IF EXISTS remote_refresh_requested_at",
    )


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements():
            op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements():
            op.execute(statement)
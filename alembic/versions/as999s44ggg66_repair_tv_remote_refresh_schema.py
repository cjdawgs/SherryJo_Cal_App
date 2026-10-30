"""repair TV remote refresh columns and admin policy"""

from alembic import op


revision = "as999s44ggg66"
down_revision = "ar998r44eee22"
branch_labels = None
depends_on = None

WORKER_ROLE = "worker_calendar_reader"


def upgrade_statements() -> tuple[str, ...]:
    return (
        "ALTER TABLE public.tv_user_state ADD COLUMN IF NOT EXISTS remote_refresh_requested_at timestamp with time zone",
        "ALTER TABLE public.tv_user_state ADD COLUMN IF NOT EXISTS remote_refresh_device_id varchar(64)",
        "DROP POLICY IF EXISTS worker_tv_state_admin ON public.tv_user_state",
        f"""CREATE POLICY worker_tv_state_admin ON public.tv_user_state
            FOR ALL TO {WORKER_ROLE}
            USING (public.worker_app_is_admin())
            WITH CHECK (public.worker_app_is_admin())""",
    )


def downgrade() -> None:
    pass


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        for statement in upgrade_statements():
            op.execute(statement)
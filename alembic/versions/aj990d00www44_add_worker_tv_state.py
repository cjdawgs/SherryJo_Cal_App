"""add worker tv state

Revision ID: aj990d00www44
Revises: ai989c99vvv33
Create Date: 2026-08-16 05:00:00.000000
"""

from alembic import op


revision = "aj990d00www44"
down_revision = "ai989c99vvv33"
branch_labels = None
depends_on = None

WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        """CREATE TABLE public.tv_user_state (
            user_id integer PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
            selected_date date,
            current_view text NOT NULL DEFAULT 'day',
            focused_event_id integer,
            sleep_guard_enabled boolean NOT NULL DEFAULT true,
            sleep_guard_timeout_minutes integer NOT NULL DEFAULT 0,
            updated_at timestamp with time zone NOT NULL DEFAULT now(),
            CONSTRAINT tv_user_state_timeout_range CHECK (
                sleep_guard_timeout_minutes BETWEEN 0 AND 1440
            )
        )""",
        "ALTER TABLE public.tv_user_state ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE public.tv_user_state FORCE ROW LEVEL SECURITY",
        f"""CREATE POLICY worker_tv_state_owner ON public.tv_user_state
            FOR ALL TO {WORKER_ROLE}
            USING (user_id = public.worker_app_user_id())
            WITH CHECK (user_id = public.worker_app_user_id())""",
        f"GRANT SELECT, INSERT, UPDATE ON TABLE public.tv_user_state TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE SELECT, INSERT, UPDATE ON TABLE public.tv_user_state FROM {WORKER_ROLE}",
        "DROP POLICY IF EXISTS worker_tv_state_owner ON public.tv_user_state",
        "DROP TABLE IF EXISTS public.tv_user_state",
    )


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements():
            op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements():
            op.execute(statement)
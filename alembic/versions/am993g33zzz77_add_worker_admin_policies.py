"""add worker admin policies

Revision ID: am993g33zzz77
Revises: al992f22yyy66
Create Date: 2026-08-16 08:00:00.000000
"""

from alembic import op


revision = "am993g33zzz77"
down_revision = "al992f22yyy66"
branch_labels = None
depends_on = None
WORKER_ROLE = "worker_calendar_reader"
TABLES = ("users", "oauth_accounts", "events", "notes", "tasks", "date_sticky_notes", "tv_diag_log")


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    statements = [
        """CREATE FUNCTION public.worker_app_is_admin() RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
        SELECT EXISTS (
            SELECT 1 FROM public.users
            WHERE id = public.worker_app_user_id() AND lower(role) = 'admin'
        ) $$""",
        "REVOKE ALL ON FUNCTION public.worker_app_is_admin() FROM PUBLIC",
        f"GRANT EXECUTE ON FUNCTION public.worker_app_is_admin() TO {WORKER_ROLE}",
    ]
    for table in TABLES:
        statements.extend((
            f"DROP POLICY IF EXISTS worker_admin_all ON public.{table}",
            f"CREATE POLICY worker_admin_all ON public.{table} FOR ALL USING (public.worker_app_is_admin()) WITH CHECK (public.worker_app_is_admin())",
            f"GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.{table} TO {WORKER_ROLE}",
        ))
    statements.append(f"GRANT USAGE ON SEQUENCE public.users_id_seq TO {WORKER_ROLE}")
    return tuple(statements)


def downgrade_statements() -> tuple[str, ...]:
    statements = [f"REVOKE USAGE ON SEQUENCE public.users_id_seq FROM {WORKER_ROLE}"]
    for table in reversed(TABLES):
        statements.extend((
            f"REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.{table} FROM {WORKER_ROLE}",
            f"DROP POLICY IF EXISTS worker_admin_all ON public.{table}",
        ))
    statements.extend((
        f"REVOKE EXECUTE ON FUNCTION public.worker_app_is_admin() FROM {WORKER_ROLE}",
        "DROP FUNCTION IF EXISTS public.worker_app_is_admin()",
    ))
    return tuple(statements)


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements(): op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements(): op.execute(statement)
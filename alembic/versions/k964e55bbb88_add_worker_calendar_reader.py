"""add_worker_calendar_reader

Revision ID: k964e55bbb88
Revises: j963d44aaa77
Create Date: 2026-08-02 00:00:00.000000

Creates the passwordless least-privilege role, event RLS policy, and
credential-free account-status projection required for the first Worker-native
bounded calendar read. Login credentials are provisioned separately.
"""

from alembic import op


revision = "k964e55bbb88"
down_revision = "j963d44aaa77"
branch_labels = None
depends_on = None


WORKER_ROLE = "worker_calendar_reader"
ACCOUNT_STATUS_VIEW = "worker_calendar_account_status"
EVENT_READ_COLUMNS = (
    "id",
    "externalId",
    "external_ids",
    "title",
    "start_time",
    "end_time",
    "description",
    "color",
    "color_enabled",
    "tags",
    "sticky_note",
    "sticky_notes",
    "created_at",
    "updated_at",
    "source",
    "account_email",
    "owner_id",
)


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    quoted_columns = ", ".join(f'"{column}"' for column in EVENT_READ_COLUMNS)
    return (
        f"""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{WORKER_ROLE}') THEN
                CREATE ROLE {WORKER_ROLE}
                    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
            END IF;
        END $$
        """,
        f"ALTER ROLE {WORKER_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
        f"""
        DO $$
        BEGIN
            EXECUTE 'GRANT CONNECT ON DATABASE '
                || quote_ident(current_database())
                || ' TO {WORKER_ROLE}';
        END $$
        """,
        f"REVOKE CREATE ON SCHEMA public FROM {WORKER_ROLE}",
        f"GRANT USAGE ON SCHEMA public TO {WORKER_ROLE}",
        f"REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {WORKER_ROLE}",
        f"REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM {WORKER_ROLE}",
        f"REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM {WORKER_ROLE}",
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM {WORKER_ROLE}",
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM {WORKER_ROLE}",
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM {WORKER_ROLE}",
        """
        CREATE OR REPLACE FUNCTION public.worker_app_user_id()
        RETURNS integer
        LANGUAGE plpgsql
        STABLE
        SET search_path = ''
        AS $$
        DECLARE
            raw_user_id text;
        BEGIN
            raw_user_id := pg_catalog.current_setting('app.user_id', true);
            IF raw_user_id IS NULL OR raw_user_id !~ '^[1-9][0-9]{0,9}$' THEN
                RETURN NULL;
            END IF;
            BEGIN
                RETURN raw_user_id::integer;
            EXCEPTION WHEN numeric_value_out_of_range THEN
                RETURN NULL;
            END;
        END
        $$
        """,
        "REVOKE ALL ON FUNCTION public.worker_app_user_id() FROM PUBLIC",
        f"GRANT EXECUTE ON FUNCTION public.worker_app_user_id() TO {WORKER_ROLE}",
        f"DROP VIEW IF EXISTS public.{ACCOUNT_STATUS_VIEW}",
        f"""
        CREATE VIEW public.{ACCOUNT_STATUS_VIEW}
        WITH (security_barrier = true)
        AS
        SELECT
            CASE
                WHEN lower(trim(provider)) IN ('outlook', 'office365', 'ms', 'msft', 'microsoft')
                    THEN 'microsoft'
                WHEN lower(trim(provider)) IN ('gmail', 'google') THEN 'google'
                WHEN lower(trim(provider)) IN ('icloud', 'caldav', 'apple') THEN 'apple'
                WHEN lower(trim(provider)) IN ('local', 'internal') THEN 'local'
                ELSE COALESCE(NULLIF(lower(trim(provider)), ''), 'other')
            END || ':' || lower(trim(account_email)) AS account_key,
            CASE
                WHEN access_token = '__REAUTH_REQUIRED__' THEN 'error'
                WHEN last_sync_success IS NOT NULL THEN 'ok'
                WHEN last_sync_failure IS NOT NULL THEN 'error'
                WHEN status = 'error' THEN 'error'
                ELSE 'ok'
            END AS account_status
        FROM public.oauth_accounts
        WHERE user_id = public.worker_app_user_id()
          AND COALESCE(is_service_provider, false) = false
          AND access_token <> 'admin-placeholder-token'
                    AND right(lower(account_email), 12) <> '@example.com'
        """,
        f"REVOKE ALL ON TABLE public.{ACCOUNT_STATUS_VIEW} FROM PUBLIC",
        f"GRANT SELECT (account_key, account_status) ON TABLE public.{ACCOUNT_STATUS_VIEW} TO {WORKER_ROLE}",
        "DROP POLICY IF EXISTS worker_calendar_reader_select ON public.events",
        f"""
        CREATE POLICY worker_calendar_reader_select ON public.events
            FOR SELECT
            TO {WORKER_ROLE}
            USING (owner_id = public.worker_app_user_id())
        """,
        f"GRANT SELECT ({quoted_columns}) ON TABLE public.events TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        "DROP POLICY IF EXISTS worker_calendar_reader_select ON public.events",
        f"REVOKE ALL ON TABLE public.events FROM {WORKER_ROLE}",
        f"REVOKE ALL ON TABLE public.{ACCOUNT_STATUS_VIEW} FROM {WORKER_ROLE}",
        f"DROP VIEW IF EXISTS public.{ACCOUNT_STATUS_VIEW}",
        f"REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {WORKER_ROLE}",
        f"REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM {WORKER_ROLE}",
        f"REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM {WORKER_ROLE}",
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM {WORKER_ROLE}",
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM {WORKER_ROLE}",
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM {WORKER_ROLE}",
        "DROP FUNCTION IF EXISTS public.worker_app_user_id()",
        f"REVOKE USAGE ON SCHEMA public FROM {WORKER_ROLE}",
        f"""
        DO $$
        BEGIN
            EXECUTE 'REVOKE CONNECT ON DATABASE '
                || quote_ident(current_database())
                || ' FROM {WORKER_ROLE}';
        END $$
        """,
        f"DROP ROLE IF EXISTS {WORKER_ROLE}",
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
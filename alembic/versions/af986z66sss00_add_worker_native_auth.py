"""add worker native auth

Revision ID: af986z66sss00
Revises: ae985y55rrr99
Create Date: 2026-08-16 01:00:00.000000
"""

from alembic import op


revision = "af986z66sss00"
down_revision = "ae985y55rrr99"
branch_labels = None
depends_on = None

WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        """
        CREATE OR REPLACE FUNCTION public.worker_find_login_user(p_identifier text)
        RETURNS TABLE (id integer, hashed_password varchar)
        LANGUAGE sql
        SECURITY DEFINER
        STABLE
        SET search_path = ''
        AS $$
            SELECT app_user.id, app_user.hashed_password
            FROM public.users AS app_user
            WHERE pg_catalog.length(pg_catalog.btrim(COALESCE(p_identifier, ''))) BETWEEN 1 AND 320
              AND CASE
                    WHEN pg_catalog.strpos(p_identifier, '@') > 0
                    THEN pg_catalog.lower(app_user.email) = pg_catalog.lower(pg_catalog.btrim(p_identifier))
                    ELSE pg_catalog.lower(app_user.username) = pg_catalog.lower(pg_catalog.btrim(p_identifier))
                  END
            LIMIT 1
        $$
        """,
        "REVOKE ALL ON FUNCTION public.worker_find_login_user(text) FROM PUBLIC",
        f"GRANT EXECUTE ON FUNCTION public.worker_find_login_user(text) TO {WORKER_ROLE}",
        """
        CREATE OR REPLACE FUNCTION public.worker_register_user(
            p_username text,
            p_email text,
            p_hashed_password text,
            p_role text DEFAULT 'staff'
        )
        RETURNS TABLE (id integer, username varchar, email varchar, role varchar)
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = ''
        AS $$
        BEGIN
            IF pg_catalog.length(pg_catalog.btrim(COALESCE(p_username, ''))) NOT BETWEEN 1 AND 100
               OR pg_catalog.length(pg_catalog.btrim(COALESCE(p_email, ''))) NOT BETWEEN 3 AND 320
               OR pg_catalog.length(COALESCE(p_hashed_password, '')) NOT BETWEEN 20 AND 512
               OR p_hashed_password NOT LIKE '$argon2id$%'
               OR pg_catalog.lower(COALESCE(p_role, '')) NOT IN ('admin', 'staff') THEN
                RAISE EXCEPTION 'invalid registration fields' USING ERRCODE = '22023';
            END IF;

            RETURN QUERY
            INSERT INTO public.users (username, email, hashed_password, role, created_at)
            VALUES (
                pg_catalog.btrim(p_username),
                pg_catalog.lower(pg_catalog.btrim(p_email)),
                p_hashed_password,
                pg_catalog.lower(p_role),
                pg_catalog.now()
            )
            RETURNING users.id, users.username, users.email, users.role;
        END
        $$
        """,
        "REVOKE ALL ON FUNCTION public.worker_register_user(text, text, text, text) FROM PUBLIC",
        f"GRANT EXECUTE ON FUNCTION public.worker_register_user(text, text, text, text) TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE EXECUTE ON FUNCTION public.worker_register_user(text, text, text, text) FROM {WORKER_ROLE}",
        f"REVOKE EXECUTE ON FUNCTION public.worker_find_login_user(text) FROM {WORKER_ROLE}",
        "DROP FUNCTION IF EXISTS public.worker_register_user(text, text, text, text)",
        "DROP FUNCTION IF EXISTS public.worker_find_login_user(text)",
    )


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements():
            op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements():
            op.execute(statement)
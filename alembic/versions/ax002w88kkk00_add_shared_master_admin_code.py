"""add shared database-backed master admin code

Revision ID: ax002w88kkk00
Revises: aw001v77jjj99
Create Date: 2026-09-11 00:00:00.000000
"""

from alembic import op


revision = "ax002w88kkk00"
down_revision = "aw001v77jjj99"
branch_labels = None
depends_on = None

WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        """
        CREATE TABLE public.app_master_admin_code (
            key_name varchar(64) PRIMARY KEY,
            secret_hash varchar(512) NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT app_master_admin_code_single_key CHECK (key_name = 'master_admin_code')
        )
        """,
        "ALTER TABLE public.app_master_admin_code ENABLE ROW LEVEL SECURITY",
        "REVOKE ALL ON TABLE public.app_master_admin_code FROM PUBLIC",
        f"REVOKE ALL ON TABLE public.app_master_admin_code FROM {WORKER_ROLE}",
        """
        DO $$
        DECLARE
            role_name text;
        BEGIN
            FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
                IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
                    EXECUTE pg_catalog.format(
                        'REVOKE ALL ON TABLE public.app_master_admin_code FROM %I',
                        role_name
                    );
                END IF;
            END LOOP;
        END;
        $$
        """,
        """
        CREATE OR REPLACE FUNCTION public.worker_get_master_admin_code_hash()
        RETURNS TABLE (secret_hash varchar, updated_at timestamptz)
        LANGUAGE sql
        SECURITY DEFINER
        STABLE
        SET search_path = ''
        AS $$
            SELECT code.secret_hash, code.updated_at
            FROM public.app_master_admin_code AS code
            WHERE code.key_name = 'master_admin_code'
            LIMIT 1
        $$
        """,
        "REVOKE ALL ON FUNCTION public.worker_get_master_admin_code_hash() FROM PUBLIC",
        f"GRANT EXECUTE ON FUNCTION public.worker_get_master_admin_code_hash() TO {WORKER_ROLE}",
        """
        CREATE OR REPLACE FUNCTION public.worker_set_master_admin_code_hash(p_secret_hash text)
        RETURNS boolean
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = ''
        AS $$
        BEGIN
            IF pg_catalog.length(COALESCE(p_secret_hash, '')) NOT BETWEEN 20 AND 512
               OR p_secret_hash NOT LIKE '$argon2id$%' THEN
                RAISE EXCEPTION 'invalid master admin code hash' USING ERRCODE = '22023';
            END IF;

            INSERT INTO public.app_master_admin_code (key_name, secret_hash, created_at, updated_at)
            VALUES ('master_admin_code', p_secret_hash, pg_catalog.now(), pg_catalog.now())
            ON CONFLICT (key_name) DO UPDATE
            SET secret_hash = EXCLUDED.secret_hash, updated_at = pg_catalog.now();
            RETURN true;
        END;
        $$
        """,
        "REVOKE ALL ON FUNCTION public.worker_set_master_admin_code_hash(text) FROM PUBLIC",
        """
        DO $$
        DECLARE
            role_name text;
        BEGIN
            FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
                IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
                    EXECUTE pg_catalog.format(
                        'REVOKE ALL ON FUNCTION public.worker_get_master_admin_code_hash() FROM %I',
                        role_name
                    );
                    EXECUTE pg_catalog.format(
                        'REVOKE ALL ON FUNCTION public.worker_set_master_admin_code_hash(text) FROM %I',
                        role_name
                    );
                END IF;
            END LOOP;
        END;
        $$
        """,
        f"GRANT EXECUTE ON FUNCTION public.worker_set_master_admin_code_hash(text) TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE EXECUTE ON FUNCTION public.worker_set_master_admin_code_hash(text) FROM {WORKER_ROLE}",
        f"REVOKE EXECUTE ON FUNCTION public.worker_get_master_admin_code_hash() FROM {WORKER_ROLE}",
        "DROP FUNCTION IF EXISTS public.worker_set_master_admin_code_hash(text)",
        "DROP FUNCTION IF EXISTS public.worker_get_master_admin_code_hash()",
        "DROP TABLE IF EXISTS public.app_master_admin_code",
    )


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements():
            op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements():
            op.execute(statement)

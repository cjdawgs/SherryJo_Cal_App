"""add worker tv pairing

Revision ID: ai989c99vvv33
Revises: ah988b88uuu22
Create Date: 2026-08-16 04:00:00.000000
"""

from alembic import op


revision = "ai989c99vvv33"
down_revision = "ah988b88uuu22"
branch_labels = None
depends_on = None

WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        """CREATE TABLE public.worker_tv_pairing_codes (
            code_hash text PRIMARY KEY,
            user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
            client_fingerprint text,
            expires_at timestamp with time zone NOT NULL,
            consumed_at timestamp with time zone,
            created_at timestamp with time zone NOT NULL DEFAULT now()
        )""",
        "ALTER TABLE public.worker_tv_pairing_codes ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE public.worker_tv_pairing_codes FORCE ROW LEVEL SECURITY",
        """CREATE FUNCTION public.worker_create_tv_pairing_code(
            p_code_hash text,
            p_expires_at timestamp with time zone,
            p_client_fingerprint text DEFAULT NULL
        ) RETURNS void
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            v_user_id integer := public.worker_app_user_id();
        BEGIN
            IF v_user_id IS NULL THEN
                RAISE EXCEPTION 'worker user identity is required';
            END IF;
            IF p_code_hash IS NULL OR length(p_code_hash) <> 64 THEN
                RAISE EXCEPTION 'pairing code hash must be SHA-256 hex';
            END IF;
            IF p_expires_at <= now() OR p_expires_at > now() + interval '10 minutes' THEN
                RAISE EXCEPTION 'pairing code expiration is invalid';
            END IF;

            DELETE FROM public.worker_tv_pairing_codes
            WHERE expires_at <= now() OR consumed_at IS NOT NULL;
            INSERT INTO public.worker_tv_pairing_codes (
                code_hash, user_id, client_fingerprint, expires_at
            ) VALUES (
                lower(p_code_hash), v_user_id, nullif(p_client_fingerprint, ''), p_expires_at
            );
        END;
        $$""",
        """CREATE FUNCTION public.worker_redeem_tv_pairing_code(p_code_hash text)
        RETURNS TABLE(user_id integer, client_fingerprint text)
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
            UPDATE public.worker_tv_pairing_codes
            SET consumed_at = now()
            WHERE code_hash = lower(p_code_hash)
              AND consumed_at IS NULL
              AND expires_at > now()
            RETURNING user_id, client_fingerprint
        $$""",
                """CREATE FUNCTION public.worker_auto_redeem_tv_pairing_code(p_client_fingerprint text)
                RETURNS TABLE(user_id integer, client_fingerprint text)
                LANGUAGE sql
                SECURITY DEFINER
                SET search_path = pg_catalog, public
                AS $$
                        UPDATE public.worker_tv_pairing_codes
                        SET consumed_at = now()
                        WHERE code_hash = (
                                SELECT candidate.code_hash
                                FROM public.worker_tv_pairing_codes AS candidate
                                WHERE candidate.client_fingerprint = nullif(p_client_fingerprint, '')
                                    AND candidate.consumed_at IS NULL
                                    AND candidate.expires_at > now()
                                ORDER BY candidate.created_at DESC
                                LIMIT 1
                                FOR UPDATE SKIP LOCKED
                        )
                        RETURNING user_id, client_fingerprint
                $$""",
        "REVOKE ALL ON FUNCTION public.worker_create_tv_pairing_code(text, timestamp with time zone, text) FROM PUBLIC",
        "REVOKE ALL ON FUNCTION public.worker_redeem_tv_pairing_code(text) FROM PUBLIC",
                "REVOKE ALL ON FUNCTION public.worker_auto_redeem_tv_pairing_code(text) FROM PUBLIC",
        f"GRANT EXECUTE ON FUNCTION public.worker_create_tv_pairing_code(text, timestamp with time zone, text) TO {WORKER_ROLE}",
        f"GRANT EXECUTE ON FUNCTION public.worker_redeem_tv_pairing_code(text) TO {WORKER_ROLE}",
                f"GRANT EXECUTE ON FUNCTION public.worker_auto_redeem_tv_pairing_code(text) TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE EXECUTE ON FUNCTION public.worker_auto_redeem_tv_pairing_code(text) FROM {WORKER_ROLE}",
        f"REVOKE EXECUTE ON FUNCTION public.worker_redeem_tv_pairing_code(text) FROM {WORKER_ROLE}",
        f"REVOKE EXECUTE ON FUNCTION public.worker_create_tv_pairing_code(text, timestamp with time zone, text) FROM {WORKER_ROLE}",
        "DROP FUNCTION IF EXISTS public.worker_auto_redeem_tv_pairing_code(text)",
        "DROP FUNCTION IF EXISTS public.worker_redeem_tv_pairing_code(text)",
        "DROP FUNCTION IF EXISTS public.worker_create_tv_pairing_code(text, timestamp with time zone, text)",
        "DROP TABLE IF EXISTS public.worker_tv_pairing_codes",
    )


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements():
            op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements():
            op.execute(statement)
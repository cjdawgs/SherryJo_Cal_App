"""add worker websocket ticket functions

Revision ID: al992f22yyy66
Revises: ak991e11xxx55
Create Date: 2026-08-16 07:00:00.000000
"""

from alembic import op


revision = "al992f22yyy66"
down_revision = "ak991e11xxx55"
branch_labels = None
depends_on = None

WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        """CREATE FUNCTION public.worker_issue_websocket_ticket(p_token_hash text, p_expires_at timestamptz)
        RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
        DECLARE v_user_id integer := public.worker_app_user_id();
        BEGIN
            IF v_user_id IS NULL THEN RAISE EXCEPTION 'worker user identity is required'; END IF;
            IF p_token_hash !~ '^[0-9a-f]{64}$' OR p_expires_at <= now() OR p_expires_at > now() + interval '2 minutes' THEN
                RAISE EXCEPTION 'invalid websocket ticket';
            END IF;
            DELETE FROM public.websocket_tickets WHERE expires_at <= now() OR consumed_at IS NOT NULL;
            INSERT INTO public.websocket_tickets(token_hash, user_id, expires_at, created_at)
            VALUES (p_token_hash, v_user_id, p_expires_at, now());
        END; $$""",
        """CREATE FUNCTION public.worker_consume_websocket_ticket(p_token_hash text)
        RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
        DECLARE v_user_id integer;
        BEGIN
            UPDATE public.websocket_tickets AS ticket SET consumed_at = now()
            WHERE ticket.token_hash = p_token_hash AND ticket.consumed_at IS NULL AND ticket.expires_at > now()
              AND EXISTS (SELECT 1 FROM public.users WHERE id = ticket.user_id)
            RETURNING ticket.user_id INTO v_user_id;
            RETURN v_user_id;
        END; $$""",
        "REVOKE ALL ON FUNCTION public.worker_issue_websocket_ticket(text, timestamptz) FROM PUBLIC",
        "REVOKE ALL ON FUNCTION public.worker_consume_websocket_ticket(text) FROM PUBLIC",
        f"GRANT EXECUTE ON FUNCTION public.worker_issue_websocket_ticket(text, timestamptz) TO {WORKER_ROLE}",
        f"GRANT EXECUTE ON FUNCTION public.worker_consume_websocket_ticket(text) TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE EXECUTE ON FUNCTION public.worker_consume_websocket_ticket(text) FROM {WORKER_ROLE}",
        f"REVOKE EXECUTE ON FUNCTION public.worker_issue_websocket_ticket(text, timestamptz) FROM {WORKER_ROLE}",
        "DROP FUNCTION IF EXISTS public.worker_consume_websocket_ticket(text)",
        "DROP FUNCTION IF EXISTS public.worker_issue_websocket_ticket(text, timestamptz)",
    )


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements():
            op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements():
            op.execute(statement)
"""add worker tv diagnostics

Revision ID: ak991e11xxx55
Revises: aj990d00www44
Create Date: 2026-08-16 06:00:00.000000
"""

from alembic import op


revision = "ak991e11xxx55"
down_revision = "aj990d00www44"
branch_labels = None
depends_on = None

WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        """CREATE FUNCTION public.worker_record_tv_diagnostics(p_entries jsonb)
        RETURNS integer
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            v_user_id integer := public.worker_app_user_id();
            v_count integer;
        BEGIN
            IF v_user_id IS NULL THEN RAISE EXCEPTION 'worker user identity is required'; END IF;
            IF jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) > 50 THEN
                RAISE EXCEPTION 'diagnostic entries must be an array of at most 50 items';
            END IF;
            v_count := jsonb_array_length(p_entries);
            INSERT INTO public.tv_diag_log (
                user_id, device_id, device_ua, event, details, ts_client,
                elapsed_min, visibility, guard_enabled, guard_timeout
            )
            SELECT
                v_user_id,
                nullif(left(entry->>'device_id', 64), ''),
                nullif(left(entry->>'device_ua', 512), ''),
                left(entry->>'event', 64),
                nullif(left(entry->>'details', 256), ''),
                nullif(left(entry->>'ts_client', 32), ''),
                CASE WHEN (entry->>'elapsed_min') ~ '^-?[0-9]+$' THEN (entry->>'elapsed_min')::integer END,
                nullif(left(entry->>'visibility', 32), ''),
                CASE WHEN entry ? 'guard_enabled' THEN (entry->>'guard_enabled')::boolean END,
                CASE WHEN (entry->>'guard_timeout') ~ '^-?[0-9]+$' THEN (entry->>'guard_timeout')::integer END
            FROM jsonb_array_elements(p_entries) AS entry
            WHERE nullif(left(entry->>'event', 64), '') IS NOT NULL
              AND (
                lower(entry->>'event') NOT IN ('heartbeat', 'poll', 'tick')
                OR NOT EXISTS (
                    SELECT 1 FROM public.tv_diag_log AS prior
                    WHERE prior.user_id = v_user_id
                      AND COALESCE(prior.device_id, '') = COALESCE(left(entry->>'device_id', 64), '')
                      AND lower(prior.event) = lower(entry->>'event')
                      AND prior.ts_server >= now() - interval '60 minutes'
                )
              );
            RETURN v_count;
        END;
        $$""",
        """CREATE FUNCTION public.worker_read_tv_diagnostics(
            p_scope text DEFAULT 'own', p_hours integer DEFAULT NULL, p_event_group text DEFAULT 'all'
        ) RETURNS TABLE (
            ts_server timestamptz, user_id integer, device_id varchar, device_ua varchar,
            event varchar, details varchar, ts_client varchar, elapsed_min integer,
            visibility varchar, guard_enabled boolean, guard_timeout integer
        )
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            v_user_id integer := public.worker_app_user_id();
            v_role text;
            v_scope text := lower(COALESCE(p_scope, 'own'));
            v_group text := lower(COALESCE(p_event_group, 'all'));
            v_hours integer := CASE WHEN p_hours IS NULL THEN NULL ELSE LEAST(GREATEST(p_hours, 1), 720) END;
        BEGIN
            SELECT role INTO v_role FROM public.users WHERE id = v_user_id;
            IF v_user_id IS NULL OR v_role IS NULL THEN RAISE EXCEPTION 'worker user identity is required'; END IF;
            IF v_scope NOT IN ('own', 'all') THEN RAISE EXCEPTION 'unsupported diagnostic scope'; END IF;
            IF v_scope = 'all' AND lower(v_role) <> 'admin' THEN RAISE EXCEPTION 'admin only' USING ERRCODE = '42501'; END IF;
            IF v_group NOT IN ('all', 'repair_risk') THEN RAISE EXCEPTION 'unsupported event group'; END IF;
            RETURN QUERY
            SELECT log.ts_server, log.user_id, log.device_id, log.device_ua, log.event,
                   log.details, log.ts_client, log.elapsed_min, log.visibility,
                   log.guard_enabled, log.guard_timeout
            FROM public.tv_diag_log AS log
            WHERE (v_scope = 'all' OR log.user_id = v_user_id)
              AND (v_hours IS NULL OR log.ts_server >= now() - make_interval(hours => v_hours))
              AND (v_group = 'all' OR log.event IN (
                  'token_invalid_401', 'kiosk_token_invalid_401',
                  'storage_token_removed', 'user_unpair_requested'
              ))
            ORDER BY log.ts_server DESC
            LIMIT 100;
        END;
        $$""",
        "REVOKE ALL ON FUNCTION public.worker_record_tv_diagnostics(jsonb) FROM PUBLIC",
        "REVOKE ALL ON FUNCTION public.worker_read_tv_diagnostics(text, integer, text) FROM PUBLIC",
        f"GRANT EXECUTE ON FUNCTION public.worker_record_tv_diagnostics(jsonb) TO {WORKER_ROLE}",
        f"GRANT EXECUTE ON FUNCTION public.worker_read_tv_diagnostics(text, integer, text) TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE EXECUTE ON FUNCTION public.worker_read_tv_diagnostics(text, integer, text) FROM {WORKER_ROLE}",
        f"REVOKE EXECUTE ON FUNCTION public.worker_record_tv_diagnostics(jsonb) FROM {WORKER_ROLE}",
        "DROP FUNCTION IF EXISTS public.worker_read_tv_diagnostics(text, integer, text)",
        "DROP FUNCTION IF EXISTS public.worker_record_tv_diagnostics(jsonb)",
    )


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements():
            op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements():
            op.execute(statement)
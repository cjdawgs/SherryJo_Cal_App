"""fix tv_diag_log ts_server default

Revision ID: ao995i55bbb99
Revises: an994h44aaa88
Create Date: 2026-08-30 00:00:00.000000

worker_record_tv_diagnostics() never populated ts_server on insert, and the
column itself had no DB-level default, so every diagnostic row written via
the Cloudflare Worker landed with ts_server = NULL. Any /tv/diag read that
applies an hours window (e.g. the admin FireTV Health Snapshot) silently
excludes NULL ts_server rows, making populated devices appear as "0 devices"
even though the unbounded Live Diagnostics Log still shows their rows.
"""

from alembic import op


revision = "ao995i55bbb99"
down_revision = "an994h44aaa88"
branch_labels = None
depends_on = None

WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        "ALTER TABLE public.tv_diag_log ALTER COLUMN ts_server SET DEFAULT now()",
        """CREATE OR REPLACE FUNCTION public.worker_record_tv_diagnostics(p_entries jsonb)
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
                ts_server, user_id, device_id, device_ua, event, details, ts_client,
                elapsed_min, visibility, guard_enabled, guard_timeout
            )
            SELECT
                now(),
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
        f"GRANT EXECUTE ON FUNCTION public.worker_record_tv_diagnostics(jsonb) TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        """CREATE OR REPLACE FUNCTION public.worker_record_tv_diagnostics(p_entries jsonb)
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
        f"GRANT EXECUTE ON FUNCTION public.worker_record_tv_diagnostics(jsonb) TO {WORKER_ROLE}",
        "ALTER TABLE public.tv_diag_log ALTER COLUMN ts_server DROP DEFAULT",
    )


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements():
            op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements():
            op.execute(statement)

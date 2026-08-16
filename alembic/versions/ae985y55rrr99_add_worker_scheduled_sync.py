"""add worker scheduled sync

Revision ID: ae985y55rrr99
Revises: ad984x44qqq88
Create Date: 2026-08-16 00:00:00.000000
"""

from alembic import op


revision = "ae985y55rrr99"
down_revision = "ad984x44qqq88"
branch_labels = None
depends_on = None

WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        "ALTER TABLE public.oauth_accounts ADD COLUMN IF NOT EXISTS sync_claimed_until timestamptz",
        """
        CREATE OR REPLACE FUNCTION public.worker_claim_due_sync_accounts(
            p_limit integer DEFAULT 10,
            p_claim_seconds integer DEFAULT 240
        )
        RETURNS TABLE (
            id integer,
            user_id integer,
            provider varchar,
            account_email varchar,
            access_token varchar,
            refresh_token varchar,
            token_expires_at timestamptz,
            sync_token json,
            sync_range_days integer,
            sync_frequency_minutes integer,
            latest_sync_marker timestamptz
        )
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = ''
        AS $$
            WITH due AS (
                SELECT account.id
                FROM public.oauth_accounts AS account
                WHERE account.sync_enabled IS TRUE
                  AND COALESCE(account.is_service_provider, false) IS FALSE
                  AND lower(account.provider) IN ('google', 'microsoft', 'apple')
                  AND account.access_token <> '__REAUTH_REQUIRED__'
                  AND (account.sync_claimed_until IS NULL OR account.sync_claimed_until < pg_catalog.now())
                  AND NOT EXISTS (
                      SELECT 1
                      FROM public.sync_operation_ledger AS ledger
                      WHERE ledger.operation_key = 'worker-sync:account:' || account.id::text || ':anchor:'
                          || COALESCE(
                              pg_catalog.floor(EXTRACT(epoch FROM GREATEST(
                                  account.last_sync, account.last_sync_success, account.last_manual_refresh_at
                              )))::bigint::text,
                              'bootstrap'
                          )
                        AND ledger.status = 'dead_letter'
                  )
                  AND pg_catalog.now() >= COALESCE(
                        GREATEST(account.last_sync, account.last_sync_success, account.last_manual_refresh_at),
                        '-infinity'::timestamptz
                      ) + pg_catalog.make_interval(mins => GREATEST(COALESCE(account.sync_frequency_minutes, 5), 1))
                      + CASE
                           WHEN lower(account.provider) = 'apple'
                               AND GREATEST(COALESCE(account.sync_frequency_minutes, 5), 1) < 240
                           THEN pg_catalog.make_interval(mins => 240 - GREATEST(COALESCE(account.sync_frequency_minutes, 5), 1))
                           ELSE pg_catalog.make_interval(mins => 0)
                        END
                ORDER BY COALESCE(
                    GREATEST(account.last_sync, account.last_sync_success, account.last_manual_refresh_at),
                    '-infinity'::timestamptz
                )
                FOR UPDATE SKIP LOCKED
                LIMIT LEAST(GREATEST(p_limit, 1), 50)
            )
            UPDATE public.oauth_accounts AS account
            SET sync_claimed_until = pg_catalog.now()
                + pg_catalog.make_interval(secs => LEAST(GREATEST(p_claim_seconds, 30), 900))
            FROM due
            WHERE account.id = due.id
            RETURNING account.id, account.user_id, account.provider, account.account_email,
                account.access_token, account.refresh_token, account.token_expires_at,
                account.sync_token, account.sync_range_days, account.sync_frequency_minutes,
                GREATEST(account.last_sync, account.last_sync_success, account.last_manual_refresh_at)
        $$
        """,
        "REVOKE ALL ON FUNCTION public.worker_claim_due_sync_accounts(integer, integer) FROM PUBLIC",
        f"GRANT EXECUTE ON FUNCTION public.worker_claim_due_sync_accounts(integer, integer) TO {WORKER_ROLE}",
        """
        CREATE OR REPLACE FUNCTION public.worker_run_scheduled_maintenance(
            p_diag_retention_days integer DEFAULT 14
        )
        RETURNS TABLE (deleted_diag_rows bigint, changes bigint, no_changes bigint, total_cycles bigint)
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = ''
        AS $$
        DECLARE
            v_deleted bigint;
            v_changes bigint;
            v_no_changes bigint;
            v_total bigint;
            v_today date := (pg_catalog.now() AT TIME ZONE 'UTC')::date;
        BEGIN
            DELETE FROM public.tv_diag_log
            WHERE ts_server < pg_catalog.now()
                - pg_catalog.make_interval(days => LEAST(GREATEST(p_diag_retention_days, 1), 365));
            GET DIAGNOSTICS v_deleted = ROW_COUNT;

            SELECT
                pg_catalog.count(*) FILTER (WHERE
                    COALESCE((result_payload ->> 'created')::integer, 0)
                    + COALESCE((result_payload ->> 'updated')::integer, 0)
                    + COALESCE((result_payload ->> 'deleted')::integer, 0) > 0
                ),
                pg_catalog.count(*) FILTER (WHERE
                    COALESCE((result_payload ->> 'created')::integer, 0)
                    + COALESCE((result_payload ->> 'updated')::integer, 0)
                    + COALESCE((result_payload ->> 'deleted')::integer, 0) = 0
                ),
                pg_catalog.count(*)
            INTO v_changes, v_no_changes, v_total
            FROM public.sync_operation_ledger
            WHERE operation_type = 'worker_scheduled_sync'
              AND status = 'succeeded'
              AND created_at >= v_today::timestamptz
              AND created_at < (v_today + 1)::timestamptz;

            INSERT INTO public.sync_efficiency_daily_rollups (
                snapshot_date, week_start_date, changes, no_changes, total_cycles,
                change_ratio, no_change_ratio, google_cache_hits, google_cache_misses,
                google_cache_total_lookups, google_cache_hit_ratio, google_cache_entries,
                created_at, updated_at
            ) VALUES (
                v_today,
                (v_today - ((EXTRACT(isodow FROM v_today)::integer - 1)))::date,
                v_changes, v_no_changes, v_total,
                CASE WHEN v_total > 0 THEN v_changes::double precision / v_total ELSE NULL END,
                CASE WHEN v_total > 0 THEN v_no_changes::double precision / v_total ELSE NULL END,
                0, 0, 0, NULL, 0, pg_catalog.now(), pg_catalog.now()
            )
            ON CONFLICT (snapshot_date) DO UPDATE SET
                week_start_date = EXCLUDED.week_start_date,
                changes = EXCLUDED.changes,
                no_changes = EXCLUDED.no_changes,
                total_cycles = EXCLUDED.total_cycles,
                change_ratio = EXCLUDED.change_ratio,
                no_change_ratio = EXCLUDED.no_change_ratio,
                updated_at = EXCLUDED.updated_at;

            RETURN QUERY SELECT v_deleted, v_changes, v_no_changes, v_total;
        END
        $$
        """,
        "REVOKE ALL ON FUNCTION public.worker_run_scheduled_maintenance(integer) FROM PUBLIC",
        f"GRANT EXECUTE ON FUNCTION public.worker_run_scheduled_maintenance(integer) TO {WORKER_ROLE}",
        f"""CREATE POLICY worker_sync_ledger_select ON public.sync_operation_ledger
            FOR SELECT TO {WORKER_ROLE}
            USING (owner_user_id = public.worker_app_user_id())""",
        f"""CREATE POLICY worker_sync_ledger_insert ON public.sync_operation_ledger
            FOR INSERT TO {WORKER_ROLE}
            WITH CHECK (owner_user_id = public.worker_app_user_id())""",
        f"""CREATE POLICY worker_sync_ledger_update ON public.sync_operation_ledger
            FOR UPDATE TO {WORKER_ROLE}
            USING (owner_user_id = public.worker_app_user_id())
            WITH CHECK (owner_user_id = public.worker_app_user_id())""",
        f"GRANT SELECT, INSERT, UPDATE ON TABLE public.sync_operation_ledger TO {WORKER_ROLE}",
        f"""GRANT UPDATE (access_token, refresh_token, token_expires_at, sync_token,
                         last_sync, last_sync_success, last_sync_failure, last_error,
                         status, sync_claimed_until, updated_at)
            ON TABLE public.oauth_accounts TO {WORKER_ROLE}""",
        f"""GRANT INSERT (\"externalId\", external_ids)
            ON TABLE public.events TO {WORKER_ROLE}""",
        f"""GRANT UPDATE (\"externalId\", external_ids, source, account_email, status)
            ON TABLE public.events TO {WORKER_ROLE}""",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE INSERT (\"externalId\", external_ids) ON TABLE public.events FROM {WORKER_ROLE}",
        f"REVOKE UPDATE (\"externalId\", external_ids, source, account_email, status) ON TABLE public.events FROM {WORKER_ROLE}",
        f"""REVOKE UPDATE (sync_token, last_sync, last_sync_success, last_sync_failure,
                          last_error, status, sync_claimed_until, updated_at)
            ON TABLE public.oauth_accounts FROM {WORKER_ROLE}""",
        f"REVOKE SELECT, INSERT, UPDATE ON TABLE public.sync_operation_ledger FROM {WORKER_ROLE}",
        "DROP POLICY IF EXISTS worker_sync_ledger_update ON public.sync_operation_ledger",
        "DROP POLICY IF EXISTS worker_sync_ledger_insert ON public.sync_operation_ledger",
        "DROP POLICY IF EXISTS worker_sync_ledger_select ON public.sync_operation_ledger",
        f"REVOKE EXECUTE ON FUNCTION public.worker_claim_due_sync_accounts(integer, integer) FROM {WORKER_ROLE}",
        f"REVOKE EXECUTE ON FUNCTION public.worker_run_scheduled_maintenance(integer) FROM {WORKER_ROLE}",
        "DROP FUNCTION IF EXISTS public.worker_run_scheduled_maintenance(integer)",
        "DROP FUNCTION IF EXISTS public.worker_claim_due_sync_accounts(integer, integer)",
        "ALTER TABLE public.oauth_accounts DROP COLUMN IF EXISTS sync_claimed_until",
    )


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements():
            op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements():
            op.execute(statement)
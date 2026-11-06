"""Align Worker provider claims with four-hour UTC slots."""

from alembic import op

revision = "aw001v77jjj99"
down_revision = "av000u66iii88"
branch_labels = None
depends_on = None


def claim_function_sql(four_hour: bool) -> str:
    if four_hour:
        due_condition = """
          AND (
            GREATEST(account.last_sync, account.last_sync_success, account.last_manual_refresh_at) IS NULL
            OR (
              pg_catalog.floor(EXTRACT(epoch FROM pg_catalog.now()) / 14400)
              >= pg_catalog.floor(EXTRACT(epoch FROM GREATEST(
                account.last_sync, account.last_sync_success, account.last_manual_refresh_at
              )) / 14400) + 1
              AND (
                GREATEST(COALESCE(account.sync_frequency_minutes, 5), 240) = 240
                AND pg_catalog.now() >= GREATEST(account.last_sync, account.last_sync_success, account.last_manual_refresh_at)
                  + pg_catalog.make_interval(mins => 239)
                OR GREATEST(COALESCE(account.sync_frequency_minutes, 5), 240) > 240
                AND pg_catalog.to_timestamp(pg_catalog.floor(EXTRACT(epoch FROM pg_catalog.now()) / 14400) * 14400)
                  >= GREATEST(account.last_sync, account.last_sync_success, account.last_manual_refresh_at)
                    + pg_catalog.make_interval(mins => GREATEST(COALESCE(account.sync_frequency_minutes, 5), 240))
              )
            )
          )
        """
    else:
        due_condition = """
          AND pg_catalog.now() >= COALESCE(
            GREATEST(account.last_sync, account.last_sync_success, account.last_manual_refresh_at),
            '-infinity'::timestamptz
          ) + pg_catalog.make_interval(mins => GREATEST(COALESCE(account.sync_frequency_minutes, 5),
              CASE WHEN lower(account.provider) = 'apple' THEN 240 ELSE 1 END))
        """
    return f"""
        CREATE OR REPLACE FUNCTION public.worker_claim_due_sync_accounts(
            p_limit integer DEFAULT 10, p_claim_seconds integer DEFAULT 240
        )
        RETURNS TABLE (
            id integer, user_id integer, provider varchar, account_email varchar,
            access_token varchar, refresh_token varchar, token_expires_at timestamptz,
            sync_token json, sync_range_days integer, sync_frequency_minutes integer,
            latest_sync_marker timestamptz
        )
        LANGUAGE sql SECURITY DEFINER SET search_path = ''
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
                      SELECT 1 FROM public.sync_operation_ledger AS ledger
                      WHERE ledger.operation_key = 'worker-sync:account:' || account.id::text || ':anchor:'
                          || COALESCE(pg_catalog.floor(EXTRACT(epoch FROM GREATEST(
                              account.last_sync, account.last_sync_success, account.last_manual_refresh_at
                          )))::bigint::text, 'bootstrap')
                        AND ledger.status = 'dead_letter'
                  )
                  {due_condition}
                ORDER BY COALESCE(GREATEST(
                    account.last_sync, account.last_sync_success, account.last_manual_refresh_at
                ), '-infinity'::timestamptz)
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
    """


def upgrade():
    if op.get_bind().dialect.name == "postgresql":
        op.execute(claim_function_sql(True))


def downgrade():
    if op.get_bind().dialect.name == "postgresql":
        op.execute(claim_function_sql(False))

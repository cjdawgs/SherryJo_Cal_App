"""prepare OAuth account columns required by Worker views and sync"""

from alembic import op


revision = "k963e55fff77"
down_revision = "j963d44aaa77"
branch_labels = None
depends_on = None


def upgrade_statements() -> tuple[str, ...]:
    return (
        "ALTER TABLE public.oauth_accounts ADD COLUMN IF NOT EXISTS last_sync_success timestamp with time zone",
        "ALTER TABLE public.oauth_accounts ADD COLUMN IF NOT EXISTS last_sync_failure timestamp with time zone",
        "ALTER TABLE public.oauth_accounts ADD COLUMN IF NOT EXISTS last_error varchar",
        "ALTER TABLE public.oauth_accounts ADD COLUMN IF NOT EXISTS status varchar DEFAULT 'ok'",
        "ALTER TABLE public.oauth_accounts ADD COLUMN IF NOT EXISTS sync_frequency_minutes integer DEFAULT 5",
        "ALTER TABLE public.oauth_accounts ADD COLUMN IF NOT EXISTS sync_range_days integer DEFAULT 30",
        "ALTER TABLE public.oauth_accounts ADD COLUMN IF NOT EXISTS last_manual_refresh_at timestamp with time zone",
        "ALTER TABLE public.oauth_accounts ADD COLUMN IF NOT EXISTS sync_token jsonb",
        """
        DO $$
        DECLARE
            expiry_data_type text;
        BEGIN
            SELECT data_type INTO expiry_data_type
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'oauth_accounts'
              AND column_name = 'token_expires_at';
            IF expiry_data_type IN ('double precision', 'real') THEN
                ALTER TABLE public.oauth_accounts
                    ALTER COLUMN token_expires_at TYPE timestamp with time zone
                    USING pg_catalog.to_timestamp(token_expires_at);
            END IF;
        END $$
        """,
        "UPDATE public.oauth_accounts SET status = 'ok' WHERE status IS NULL",
        "UPDATE public.oauth_accounts SET sync_frequency_minutes = 5 WHERE sync_frequency_minutes IS NULL",
        "UPDATE public.oauth_accounts SET sync_range_days = 30 WHERE sync_range_days IS NULL",
        "ALTER TABLE public.oauth_accounts ALTER COLUMN status SET DEFAULT 'ok', ALTER COLUMN status SET NOT NULL",
        "ALTER TABLE public.oauth_accounts ALTER COLUMN sync_frequency_minutes SET DEFAULT 5, ALTER COLUMN sync_frequency_minutes SET NOT NULL",
        "ALTER TABLE public.oauth_accounts ALTER COLUMN sync_range_days SET DEFAULT 30, ALTER COLUMN sync_range_days SET NOT NULL",
        "ALTER TABLE public.oauth_accounts ALTER COLUMN is_primary SET DEFAULT false",
        "ALTER TABLE public.oauth_accounts ALTER COLUMN sync_enabled SET DEFAULT true",
        "ALTER TABLE public.events ADD COLUMN IF NOT EXISTS external_ids jsonb",
        "ALTER TABLE public.events ADD COLUMN IF NOT EXISTS source varchar DEFAULT 'local'",
        "ALTER TABLE public.events ADD COLUMN IF NOT EXISTS account_email varchar",
        "ALTER TABLE public.events ADD COLUMN IF NOT EXISTS color varchar",
        "ALTER TABLE public.events ADD COLUMN IF NOT EXISTS tags jsonb",
        "ALTER TABLE public.events ADD COLUMN IF NOT EXISTS sticky_note jsonb",
        "ALTER TABLE public.events ADD COLUMN IF NOT EXISTS sticky_notes jsonb",
        "ALTER TABLE public.events ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone",
        "CREATE INDEX IF NOT EXISTS ix_events_source ON public.events (source)",
        "CREATE INDEX IF NOT EXISTS ix_events_account_email ON public.events (account_email)",
    )


def downgrade() -> None:
    pass


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        for statement in upgrade_statements():
            op.execute(statement)
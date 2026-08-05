"""apply_worker_oauth_writer_grants

Revision ID: aa981u11nnn55
Revises: z979t00lll33
Create Date: 2026-08-05 00:00:00.000000

Applies the oauth_accounts grants and RLS policies from bb981v22nnn55 that
were provisioned manually against production. Running this migration on a
fresh database makes those grants idempotent.
"""

from alembic import op

revision = "aa981u11nnn55"
down_revision = "z979t00lll33"
branch_labels = None
depends_on = None

WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        """CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_account_user_provider_email
           ON public.oauth_accounts(user_id, provider, account_email)""",
        f"""DO $$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_policies
                WHERE tablename = 'oauth_accounts' AND policyname = 'worker_oauth_reader'
            ) THEN
                CREATE POLICY worker_oauth_reader ON public.oauth_accounts
                    FOR SELECT TO {WORKER_ROLE}
                    USING (user_id = public.worker_app_user_id());
            END IF;
        END $$""",
        f"""DO $$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_policies
                WHERE tablename = 'oauth_accounts' AND policyname = 'worker_oauth_writer_insert'
            ) THEN
                CREATE POLICY worker_oauth_writer_insert ON public.oauth_accounts
                    FOR INSERT TO {WORKER_ROLE}
                    WITH CHECK (user_id = public.worker_app_user_id());
            END IF;
        END $$""",
        f"""DO $$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_policies
                WHERE tablename = 'oauth_accounts' AND policyname = 'worker_oauth_writer_update'
            ) THEN
                CREATE POLICY worker_oauth_writer_update ON public.oauth_accounts
                    FOR UPDATE TO {WORKER_ROLE}
                    USING (user_id = public.worker_app_user_id())
                    WITH CHECK (user_id = public.worker_app_user_id());
            END IF;
        END $$""",
        f"GRANT SELECT ON TABLE public.oauth_accounts TO {WORKER_ROLE}",
        f"""GRANT INSERT (user_id, provider, account_email, access_token,
                         refresh_token, token_expires_at, display_name,
                         provider_id, is_service_provider)
            ON TABLE public.oauth_accounts TO {WORKER_ROLE}""",
        f"""GRANT UPDATE (access_token, refresh_token, token_expires_at,
                         display_name, provider_id)
            ON TABLE public.oauth_accounts TO {WORKER_ROLE}""",
        f"GRANT USAGE ON SEQUENCE public.oauth_accounts_id_seq TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE USAGE ON SEQUENCE public.oauth_accounts_id_seq FROM {WORKER_ROLE}",
        f"REVOKE INSERT, UPDATE ON TABLE public.oauth_accounts FROM {WORKER_ROLE}",
        f"REVOKE SELECT ON TABLE public.oauth_accounts FROM {WORKER_ROLE}",
        f"DROP POLICY IF EXISTS worker_oauth_writer_update ON public.oauth_accounts",
        f"DROP POLICY IF EXISTS worker_oauth_writer_insert ON public.oauth_accounts",
        f"DROP POLICY IF EXISTS worker_oauth_reader ON public.oauth_accounts",
    )


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements():
            op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements():
            op.execute(statement)

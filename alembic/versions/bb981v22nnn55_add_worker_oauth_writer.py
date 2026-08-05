"""add_worker_oauth_writer

Revision ID: bb981v22nnn55
Revises: aa980u11mmm44
Create Date: 2026-08-05 00:00:00.000000
"""

from alembic import op

revision = "bb981v22nnn55"
down_revision = "aa980u11mmm44"
branch_labels = None
depends_on = None
WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        # Remove duplicate rows, keeping the highest id per natural key.
        """DELETE FROM public.oauth_accounts a USING public.oauth_accounts b
           WHERE a.id < b.id
             AND a.user_id = b.user_id
             AND a.provider = b.provider
             AND a.account_email = b.account_email""",
        # Unique index required for ON CONFLICT upsert.
        """CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_account_user_provider_email
           ON public.oauth_accounts(user_id, provider, account_email)""",
        # RLS: worker reads only its own rows.
        f"""CREATE POLICY worker_oauth_reader ON public.oauth_accounts
            FOR SELECT TO {WORKER_ROLE}
            USING (user_id = public.worker_app_user_id())""",
        # RLS: worker inserts only its own rows.
        f"""CREATE POLICY worker_oauth_writer_insert ON public.oauth_accounts
            FOR INSERT TO {WORKER_ROLE}
            WITH CHECK (user_id = public.worker_app_user_id())""",
        # RLS: worker updates only its own rows.
        f"""CREATE POLICY worker_oauth_writer_update ON public.oauth_accounts
            FOR UPDATE TO {WORKER_ROLE}
            USING (user_id = public.worker_app_user_id())
            WITH CHECK (user_id = public.worker_app_user_id())""",
        # Grants scoped to only the columns the Worker needs.
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
        "DROP INDEX IF EXISTS uq_oauth_account_user_provider_email",
    )


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements():
            op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements():
            op.execute(statement)

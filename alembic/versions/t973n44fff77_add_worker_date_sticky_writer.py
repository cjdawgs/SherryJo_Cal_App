"""add_worker_date_sticky_writer

Revision ID: t973n44fff77
Revises: s972m33eee66
Create Date: 2026-08-04 00:00:00.000000

Adds replay-safe, owner-scoped Worker writes for date-sticky notes.
"""

from alembic import op


revision = "t973n44fff77"
down_revision = "s972m33eee66"
branch_labels = None
depends_on = None


WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        """
        CREATE TABLE public.worker_write_receipts (
            owner_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
            idempotency_key VARCHAR(200) NOT NULL,
            operation VARCHAR(100) NOT NULL,
            request_hash VARCHAR(64) NOT NULL,
            response_body JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (owner_id, idempotency_key)
        )
        """,
        "ALTER TABLE public.worker_write_receipts ENABLE ROW LEVEL SECURITY",
        f"""
        CREATE POLICY worker_write_receipt_select ON public.worker_write_receipts
            FOR SELECT TO {WORKER_ROLE}
            USING (owner_id = public.worker_app_user_id())
        """,
        f"""
        CREATE POLICY worker_write_receipt_insert ON public.worker_write_receipts
            FOR INSERT TO {WORKER_ROLE}
            WITH CHECK (owner_id = public.worker_app_user_id())
        """,
        f"""
        CREATE POLICY worker_date_sticky_writer_insert ON public.date_sticky_notes
            FOR INSERT TO {WORKER_ROLE}
            WITH CHECK (owner_id = public.worker_app_user_id())
        """,
        f"""
        CREATE POLICY worker_date_sticky_writer_update ON public.date_sticky_notes
            FOR UPDATE TO {WORKER_ROLE}
            USING (owner_id = public.worker_app_user_id())
            WITH CHECK (owner_id = public.worker_app_user_id())
        """,
        f"""
        CREATE POLICY worker_date_sticky_writer_delete ON public.date_sticky_notes
            FOR DELETE TO {WORKER_ROLE}
            USING (owner_id = public.worker_app_user_id())
        """,
        f"GRANT SELECT (owner_id, idempotency_key, operation, request_hash, response_body) ON TABLE public.worker_write_receipts TO {WORKER_ROLE}",
        f"GRANT INSERT (owner_id, idempotency_key, operation, request_hash, response_body) ON TABLE public.worker_write_receipts TO {WORKER_ROLE}",
        f"GRANT INSERT (owner_id, date, sticky_notes, updated_at) ON TABLE public.date_sticky_notes TO {WORKER_ROLE}",
        f"GRANT UPDATE (sticky_notes, updated_at) ON TABLE public.date_sticky_notes TO {WORKER_ROLE}",
        f"GRANT DELETE ON TABLE public.date_sticky_notes TO {WORKER_ROLE}",
        f"GRANT USAGE ON SEQUENCE public.date_sticky_notes_id_seq TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE USAGE ON SEQUENCE public.date_sticky_notes_id_seq FROM {WORKER_ROLE}",
        f"REVOKE INSERT, UPDATE, DELETE ON TABLE public.date_sticky_notes FROM {WORKER_ROLE}",
        "DROP POLICY IF EXISTS worker_date_sticky_writer_delete ON public.date_sticky_notes",
        "DROP POLICY IF EXISTS worker_date_sticky_writer_update ON public.date_sticky_notes",
        "DROP POLICY IF EXISTS worker_date_sticky_writer_insert ON public.date_sticky_notes",
        "DROP TABLE IF EXISTS public.worker_write_receipts",
    )


def upgrade() -> None:
    if not _is_postgres():
        return
    for statement in upgrade_statements():
        op.execute(statement)


def downgrade() -> None:
    if not _is_postgres():
        return
    for statement in downgrade_statements():
        op.execute(statement)
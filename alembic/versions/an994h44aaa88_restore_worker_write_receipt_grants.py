"""restore worker write receipt grants

Revision ID: an994h44aaa88
Revises: am993g33zzz77
Create Date: 2026-08-16 15:15:00.000000
"""

from alembic import op


revision = "an994h44aaa88"
down_revision = "am993g33zzz77"
branch_labels = None
depends_on = None

WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    columns = "owner_id, idempotency_key, operation, request_hash, response_body"
    return (
        f"GRANT SELECT ({columns}) ON TABLE public.worker_write_receipts TO {WORKER_ROLE}",
        f"GRANT INSERT ({columns}) ON TABLE public.worker_write_receipts TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE INSERT ON TABLE public.worker_write_receipts FROM {WORKER_ROLE}",
        f"REVOKE SELECT ON TABLE public.worker_write_receipts FROM {WORKER_ROLE}",
    )


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements():
            op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements():
            op.execute(statement)
"""harden_worker_write_receipts_rls

Revision ID: z979t00lll33
Revises: y978s99kkk22
Create Date: 2026-08-04 00:00:00.000000
"""

from alembic import op


revision = "z979t00lll33"
down_revision = "y978s99kkk22"
branch_labels = None
depends_on = None


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        "ALTER TABLE public.worker_write_receipts ENABLE ROW LEVEL SECURITY",
        "REVOKE ALL ON TABLE public.worker_write_receipts FROM anon, authenticated",
    )


def upgrade() -> None:
    if not _is_postgres():
        return
    for statement in upgrade_statements():
        op.execute(statement)


def downgrade() -> None:
    return
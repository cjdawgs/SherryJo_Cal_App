"""enable_rls_on_sync_operation_ledger

Revision ID: ad984x44qqq88
Revises: ac983w33ppp77
Create Date: 2026-08-07 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "ad984x44qqq88"
down_revision = "ac983w33ppp77"
branch_labels = None
depends_on = None


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _existing_tables() -> set:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    if not _is_postgres():
        return

    if "sync_operation_ledger" in _existing_tables():
        op.execute('ALTER TABLE public."sync_operation_ledger" ENABLE ROW LEVEL SECURITY')


def downgrade() -> None:
    if not _is_postgres():
        return

    if "sync_operation_ledger" in _existing_tables():
        op.execute('ALTER TABLE public."sync_operation_ledger" DISABLE ROW LEVEL SECURITY')
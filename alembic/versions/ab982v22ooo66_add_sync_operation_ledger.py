"""add_sync_operation_ledger

Revision ID: ab982v22ooo66
Revises: aa981u11nnn55
Create Date: 2026-08-05 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "ab982v22ooo66"
down_revision = "aa981u11nnn55"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if not sa.inspect(op.get_bind()).has_table("sync_operation_ledger"):
        op.create_table(
            "sync_operation_ledger",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("operation_key", sa.String(length=200), nullable=False),
            sa.Column("operation_type", sa.String(length=100), nullable=False),
            sa.Column("owner_user_id", sa.Integer(), nullable=True),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("request_payload", sa.JSON(), nullable=True),
            sa.Column("result_payload", sa.JSON(), nullable=True),
            sa.Column("error_type", sa.String(), nullable=True),
            sa.Column("error_message", sa.String(), nullable=True),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("operation_key", name="uq_sync_operation_ledger_operation_key"),
        )

    op.execute("ALTER TABLE sync_operation_ledger ALTER COLUMN attempt_count SET DEFAULT 1")
    op.execute("CREATE INDEX IF NOT EXISTS ix_sync_operation_ledger_operation_key ON sync_operation_ledger (operation_key)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_sync_operation_ledger_operation_type ON sync_operation_ledger (operation_type)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_sync_operation_ledger_owner_user_id ON sync_operation_ledger (owner_user_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_sync_operation_ledger_status ON sync_operation_ledger (status)")


def downgrade() -> None:
    op.drop_index("ix_sync_operation_ledger_status", table_name="sync_operation_ledger")
    op.drop_index("ix_sync_operation_ledger_owner_user_id", table_name="sync_operation_ledger")
    op.drop_index("ix_sync_operation_ledger_operation_type", table_name="sync_operation_ledger")
    op.drop_index("ix_sync_operation_ledger_operation_key", table_name="sync_operation_ledger")
    op.drop_table("sync_operation_ledger")

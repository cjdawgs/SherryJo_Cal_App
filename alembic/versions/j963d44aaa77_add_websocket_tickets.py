"""add_websocket_tickets

Revision ID: j963d44aaa77
Revises: i962c33fff66
Create Date: 2026-08-02 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "j963d44aaa77"
down_revision = "i962c33fff66"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "websocket_tickets",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_websocket_tickets_expires_at", "websocket_tickets", ["expires_at"], unique=False)
    op.create_index("ix_websocket_tickets_id", "websocket_tickets", ["id"], unique=False)
    op.create_index("ix_websocket_tickets_token_hash", "websocket_tickets", ["token_hash"], unique=True)
    op.create_index("ix_websocket_tickets_user_id", "websocket_tickets", ["user_id"], unique=False)

    if op.get_bind().dialect.name == "postgresql":
        op.execute("ALTER TABLE public.websocket_tickets ENABLE ROW LEVEL SECURITY")
        for role in ("anon", "authenticated"):
            op.execute(
                f"DO $$ BEGIN "
                f"IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN "
                f"REVOKE ALL ON TABLE public.websocket_tickets FROM {role}; "
                f"END IF; END $$;"
            )


def downgrade() -> None:
    op.drop_index("ix_websocket_tickets_user_id", table_name="websocket_tickets")
    op.drop_index("ix_websocket_tickets_token_hash", table_name="websocket_tickets")
    op.drop_index("ix_websocket_tickets_id", table_name="websocket_tickets")
    op.drop_index("ix_websocket_tickets_expires_at", table_name="websocket_tickets")
    op.drop_table("websocket_tickets")
"""add_is_service_provider_flag

Revision ID: e957e88aaa11
Revises: d956d77999e7
Create Date: 2026-06-27 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "e957e88aaa11"
down_revision = "d956d77999e7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "oauth_accounts",
        sa.Column("is_service_provider", sa.Boolean(), nullable=True, server_default=sa.false()),
    )

    op.execute(
        """
        UPDATE oauth_accounts
        SET is_service_provider = TRUE
        WHERE access_token = 'admin-placeholder-token'
        """
    )

    op.execute(
        """
        UPDATE oauth_accounts
        SET is_service_provider = FALSE
        WHERE is_service_provider IS NULL
        """
    )

    op.alter_column(
        "oauth_accounts",
        "is_service_provider",
        existing_type=sa.Boolean(),
        nullable=False,
        server_default=sa.false(),
    )
    op.create_index(
        op.f("ix_oauth_accounts_is_service_provider"),
        "oauth_accounts",
        ["is_service_provider"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_oauth_accounts_is_service_provider"), table_name="oauth_accounts")
    op.drop_column("oauth_accounts", "is_service_provider")

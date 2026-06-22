"""add_color_to_oauth_accounts

Revision ID: c955c66988d6
Revises: b954c55977c5
Create Date: 2026-06-22 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "c955c66988d6"
down_revision = "b954c55977c5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("oauth_accounts", sa.Column("color", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("oauth_accounts", "color")

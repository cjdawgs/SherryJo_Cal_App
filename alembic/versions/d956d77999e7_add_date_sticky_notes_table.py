"""add_date_sticky_notes_table

Revision ID: d956d77999e7
Revises: c955c66988d6
Create Date: 2026-06-24 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "d956d77999e7"
down_revision = "c955c66988d6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "date_sticky_notes",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("owner_id", sa.Integer(), nullable=False),
        sa.Column("date", sa.String(), nullable=False),
        sa.Column("sticky_notes", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("owner_id", "date", name="uq_date_sticky_owner_date"),
    )
    op.create_index(op.f("ix_date_sticky_notes_id"), "date_sticky_notes", ["id"], unique=False)
    op.create_index(op.f("ix_date_sticky_notes_owner_id"), "date_sticky_notes", ["owner_id"], unique=False)
    op.create_index(op.f("ix_date_sticky_notes_date"), "date_sticky_notes", ["date"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_date_sticky_notes_date"), table_name="date_sticky_notes")
    op.drop_index(op.f("ix_date_sticky_notes_owner_id"), table_name="date_sticky_notes")
    op.drop_index(op.f("ix_date_sticky_notes_id"), table_name="date_sticky_notes")
    op.drop_table("date_sticky_notes")

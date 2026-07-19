"""add_event_color_enablement_and_tag_settings

Revision ID: g959a00ccc33
Revises: f958f99bbb22
Create Date: 2026-07-19 00:00:00.000000

Persist per-event color enablement and user-owned tag color render settings.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "g959a00ccc33"
down_revision = "f958f99bbb22"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "events",
        sa.Column("color_enabled", sa.Boolean(), server_default=sa.false(), nullable=False),
    )

    op.create_table(
        "event_tag_color_settings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("owner_id", sa.Integer(), nullable=False),
        sa.Column("tag_key", sa.String(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("color", sa.String(), nullable=True),
        sa.Column("enabled", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("owner_id", "tag_key", name="uq_event_tag_color_owner_tag"),
    )
    op.create_index(op.f("ix_event_tag_color_settings_id"), "event_tag_color_settings", ["id"], unique=False)
    op.create_index(op.f("ix_event_tag_color_settings_owner_id"), "event_tag_color_settings", ["owner_id"], unique=False)
    op.create_index(op.f("ix_event_tag_color_settings_tag_key"), "event_tag_color_settings", ["tag_key"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_event_tag_color_settings_tag_key"), table_name="event_tag_color_settings")
    op.drop_index(op.f("ix_event_tag_color_settings_owner_id"), table_name="event_tag_color_settings")
    op.drop_index(op.f("ix_event_tag_color_settings_id"), table_name="event_tag_color_settings")
    op.drop_table("event_tag_color_settings")
    op.drop_column("events", "color_enabled")
"""add_sync_efficiency_daily_rollups

Revision ID: i962c33fff66
Revises: h961b22eee55
Create Date: 2026-07-30 00:00:00.000000

Adds a persistent daily rollup table for scheduler efficiency and Google
calendarList cache metrics so operations can track week-over-week sync cost
trends in Supabase/Postgres.
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "i962c33fff66"
down_revision = "h961b22eee55"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sync_efficiency_daily_rollups",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("snapshot_date", sa.Date(), nullable=False),
        sa.Column("week_start_date", sa.Date(), nullable=False),
        sa.Column("changes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("no_changes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_cycles", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("change_ratio", sa.Float(), nullable=True),
        sa.Column("no_change_ratio", sa.Float(), nullable=True),
        sa.Column("google_cache_hits", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("google_cache_misses", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("google_cache_total_lookups", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("google_cache_hit_ratio", sa.Float(), nullable=True),
        sa.Column("google_cache_entries", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("snapshot_date", name="uq_sync_efficiency_snapshot_date"),
    )

    op.create_index(
        "ix_sync_efficiency_daily_rollups_snapshot_date",
        "sync_efficiency_daily_rollups",
        ["snapshot_date"],
        unique=False,
    )
    op.create_index(
        "ix_sync_efficiency_daily_rollups_week_start_date",
        "sync_efficiency_daily_rollups",
        ["week_start_date"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_sync_efficiency_daily_rollups_week_start_date", table_name="sync_efficiency_daily_rollups")
    op.drop_index("ix_sync_efficiency_daily_rollups_snapshot_date", table_name="sync_efficiency_daily_rollups")
    op.drop_table("sync_efficiency_daily_rollups")

"""add_tv_diag_log_table

Revision ID: f958f99bbb22
Revises: e957e88aaa11
Create Date: 2026-07-04 00:00:00.000000

Persistent TV sleep-guard diagnostic log.  Written to Supabase/Postgres so it
survives server restarts and is queryable from any device over the network.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "f958f99bbb22"
down_revision = "e957e88aaa11"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "tv_diag_log",
        sa.Column("id",            sa.Integer(),                       primary_key=True),
        sa.Column("ts_server",     sa.DateTime(timezone=True),         nullable=True),
        sa.Column("user_id",       sa.Integer(),                       nullable=True),
        sa.Column("device_id",     sa.String(),                        nullable=True),
        sa.Column("device_ua",     sa.String(),                        nullable=True),
        sa.Column("event",         sa.String(),                        nullable=False),
        sa.Column("details",       sa.String(),                        nullable=True),
        sa.Column("ts_client",     sa.String(),                        nullable=True),
        sa.Column("elapsed_min",   sa.Integer(),                       nullable=True),
        sa.Column("visibility",    sa.String(),                        nullable=True),
        sa.Column("guard_enabled", sa.Boolean(),                       nullable=True),
        sa.Column("guard_timeout", sa.Integer(),                       nullable=True),
    )
    op.create_index("ix_tv_diag_log_id",        "tv_diag_log", ["id"],        unique=True)
    op.create_index("ix_tv_diag_log_ts_server", "tv_diag_log", ["ts_server"], unique=False)
    op.create_index("ix_tv_diag_log_user_id",   "tv_diag_log", ["user_id"],   unique=False)
    op.create_index("ix_tv_diag_log_device_id", "tv_diag_log", ["device_id"], unique=False)

    # Foreign key constraint (soft — nullable, no cascade needed for a log table)
    op.create_foreign_key(
        "fk_tv_diag_log_user_id",
        "tv_diag_log", "users",
        ["user_id"], ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_tv_diag_log_user_id", "tv_diag_log", type_="foreignkey")
    op.drop_index("ix_tv_diag_log_device_id", table_name="tv_diag_log")
    op.drop_index("ix_tv_diag_log_user_id",   table_name="tv_diag_log")
    op.drop_index("ix_tv_diag_log_ts_server", table_name="tv_diag_log")
    op.drop_index("ix_tv_diag_log_id",        table_name="tv_diag_log")
    op.drop_table("tv_diag_log")

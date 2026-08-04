"""add_event_recurrence

Revision ID: l965f66ccc99
Revises: k964e55bbb88
Create Date: 2026-08-04 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "l965f66ccc99"
down_revision = "k964e55bbb88"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("events", sa.Column("recurrence", sa.JSON(), nullable=True))
    if op.get_bind().dialect.name == "postgresql":
        op.execute('GRANT SELECT (recurrence) ON TABLE events TO worker_calendar_reader')


def downgrade() -> None:
    op.drop_column("events", "recurrence")
"""add worker account reads

Revision ID: ag987a77ttt11
Revises: af986z66sss00
Create Date: 2026-08-16 02:00:00.000000
"""

from alembic import op


revision = "ag987a77ttt11"
down_revision = "af986z66sss00"
branch_labels = None
depends_on = None

WORKER_ROLE = "worker_calendar_reader"
ROLLUP_COLUMNS = (
    "snapshot_date", "week_start_date", "changes", "no_changes", "total_cycles",
    "change_ratio", "no_change_ratio", "google_cache_hits", "google_cache_misses",
    "google_cache_total_lookups", "google_cache_hit_ratio", "google_cache_entries", "updated_at",
)


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    columns = ", ".join(f'"{column}"' for column in ROLLUP_COLUMNS)
    return (f"GRANT SELECT ({columns}) ON TABLE public.sync_efficiency_daily_rollups TO {WORKER_ROLE}",)


def downgrade_statements() -> tuple[str, ...]:
    columns = ", ".join(f'"{column}"' for column in ROLLUP_COLUMNS)
    return (f"REVOKE SELECT ({columns}) ON TABLE public.sync_efficiency_daily_rollups FROM {WORKER_ROLE}",)


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements():
            op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements():
            op.execute(statement)
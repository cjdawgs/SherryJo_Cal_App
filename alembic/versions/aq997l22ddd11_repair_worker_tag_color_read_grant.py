"""repair_worker_tag_color_read_grant

Revision ID: aq997l22ddd11
Revises: ap996k11ccc00
Create Date: 2026-09-10 00:00:00.000000
"""

from alembic import op


revision = "aq997l22ddd11"
down_revision = "ap996k11ccc00"
branch_labels = None
depends_on = None

WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        "ALTER TABLE public.event_tag_color_settings ENABLE ROW LEVEL SECURITY",
        "DROP POLICY IF EXISTS worker_tag_color_reader_select ON public.event_tag_color_settings",
        f"""CREATE POLICY worker_tag_color_reader_select ON public.event_tag_color_settings
            FOR SELECT TO {WORKER_ROLE}
            USING (owner_id = public.worker_app_user_id())""",
        f"GRANT SELECT (owner_id, tag_key, label, color, enabled) ON TABLE public.event_tag_color_settings TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE SELECT (owner_id, tag_key, label, color, enabled) ON TABLE public.event_tag_color_settings FROM {WORKER_ROLE}",
        "DROP POLICY IF EXISTS worker_tag_color_reader_select ON public.event_tag_color_settings",
    )


def upgrade() -> None:
    if _is_postgres():
        for statement in upgrade_statements():
            op.execute(statement)


def downgrade() -> None:
    if _is_postgres():
        for statement in downgrade_statements():
            op.execute(statement)

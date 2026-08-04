"""add_worker_tag_color_reader

Revision ID: p969j00bbb33
Revises: o968i99aaa22
Create Date: 2026-08-04 00:00:00.000000

Adds owner-scoped, read-only access for Worker-native tag-color reads.
"""

from alembic import op


revision = "p969j00bbb33"
down_revision = "o968i99aaa22"
branch_labels = None
depends_on = None


WORKER_ROLE = "worker_calendar_reader"
TAG_COLOR_READ_COLUMNS = ("tag_key", "label", "color", "enabled")


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    quoted_columns = ", ".join(f'"{column}"' for column in TAG_COLOR_READ_COLUMNS)
    return (
        "ALTER TABLE public.event_tag_color_settings ENABLE ROW LEVEL SECURITY",
        "DROP POLICY IF EXISTS worker_tag_color_reader_select ON public.event_tag_color_settings",
        f"""
        CREATE POLICY worker_tag_color_reader_select ON public.event_tag_color_settings
            FOR SELECT
            TO {WORKER_ROLE}
            USING (owner_id = public.worker_app_user_id())
        """,
        f"GRANT SELECT ({quoted_columns}) ON TABLE public.event_tag_color_settings TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        "DROP POLICY IF EXISTS worker_tag_color_reader_select ON public.event_tag_color_settings",
        f"REVOKE ALL ON TABLE public.event_tag_color_settings FROM {WORKER_ROLE}",
    )


def upgrade() -> None:
    if not _is_postgres():
        return
    for statement in upgrade_statements():
        op.execute(statement)


def downgrade() -> None:
    if not _is_postgres():
        return
    for statement in downgrade_statements():
        op.execute(statement)
"""add_worker_tag_color_writer

Revision ID: u974o55ggg88
Revises: t973n44fff77
Create Date: 2026-08-04 00:00:00.000000

Adds owner-scoped Worker writes for event tag color settings.
"""

from alembic import op


revision = "u974o55ggg88"
down_revision = "t973n44fff77"
branch_labels = None
depends_on = None


WORKER_ROLE = "worker_calendar_reader"


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        f"""
        CREATE POLICY worker_tag_color_writer_insert ON public.event_tag_color_settings
            FOR INSERT TO {WORKER_ROLE}
            WITH CHECK (owner_id = public.worker_app_user_id())
        """,
        f"""
        CREATE POLICY worker_tag_color_writer_update ON public.event_tag_color_settings
            FOR UPDATE TO {WORKER_ROLE}
            USING (owner_id = public.worker_app_user_id())
            WITH CHECK (owner_id = public.worker_app_user_id())
        """,
        f"GRANT INSERT (owner_id, tag_key, label, color, enabled, updated_at) ON TABLE public.event_tag_color_settings TO {WORKER_ROLE}",
        f"GRANT UPDATE (label, color, enabled, updated_at) ON TABLE public.event_tag_color_settings TO {WORKER_ROLE}",
        f"GRANT USAGE ON SEQUENCE public.event_tag_color_settings_id_seq TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE USAGE ON SEQUENCE public.event_tag_color_settings_id_seq FROM {WORKER_ROLE}",
        f"REVOKE INSERT, UPDATE ON TABLE public.event_tag_color_settings FROM {WORKER_ROLE}",
        "DROP POLICY IF EXISTS worker_tag_color_writer_update ON public.event_tag_color_settings",
        "DROP POLICY IF EXISTS worker_tag_color_writer_insert ON public.event_tag_color_settings",
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
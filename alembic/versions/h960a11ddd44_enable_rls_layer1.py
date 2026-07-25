"""enable_rls_layer1

Revision ID: h960a11ddd44
Revises: g959a00ccc33
Create Date: 2026-07-25 00:00:00.000000

Layer-1 Row Level Security.

Enables RLS on every application table and removes the PostgREST-facing
grants (``anon`` / ``authenticated``).  The backend connects as the table
owner, which bypasses RLS, so this is transparent to the running
application while closing direct data-API access to the schema.

PostgreSQL only -- SQLite has no RLS and is skipped.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "h960a11ddd44"
down_revision = "g959a00ccc33"
branch_labels = None
depends_on = None


RLS_TABLES = (
    "users",
    "oauth_accounts",
    "events",
    "notes",
    "tasks",
    "date_sticky_notes",
    "event_tag_color_settings",
    "tv_diag_log",
)


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _existing_tables() -> set:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    if not _is_postgres():
        return

    present = _existing_tables()

    for table in RLS_TABLES:
        if table in present:
            op.execute(f'ALTER TABLE public."{table}" ENABLE ROW LEVEL SECURITY')

    for role in ("anon", "authenticated"):
        op.execute(
            f"""
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
                    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {role};
                    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM {role};
                    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM {role};
                    ALTER DEFAULT PRIVILEGES IN SCHEMA public
                        REVOKE ALL ON TABLES FROM {role};
                    ALTER DEFAULT PRIVILEGES IN SCHEMA public
                        REVOKE ALL ON SEQUENCES FROM {role};
                END IF;
            END $$;
            """
        )


def downgrade() -> None:
    if not _is_postgres():
        return

    present = _existing_tables()

    for table in RLS_TABLES:
        if table in present:
            op.execute(f'ALTER TABLE public."{table}" DISABLE ROW LEVEL SECURITY')

    # Grants are intentionally NOT restored: re-exposing the schema to the
    # public data API must be a deliberate, manual action.

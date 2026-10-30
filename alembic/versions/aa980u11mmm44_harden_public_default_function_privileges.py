"""harden_public_default_function_privileges

Revision ID: aa980u11mmm44
Revises: z979t00lll33
Create Date: 2026-08-04 00:00:00.000000
"""

from alembic import op


revision = "aa980u11mmm44"
down_revision = "z979t00lll33"
branch_labels = None
depends_on = None


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade_statements() -> tuple[str, ...]:
    return (
        """
        DO $$
        DECLARE
            role_name text;
        BEGIN
            FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
                    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
                        || 'REVOKE ALL ON FUNCTIONS FROM ' || quote_ident(role_name);
                END IF;
            END LOOP;
        END $$
        """,
    )


def upgrade() -> None:
    if not _is_postgres():
        return
    for statement in upgrade_statements():
        op.execute(statement)


def downgrade() -> None:
    return
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
    return tuple(
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM {role}"
        for role in ("anon", "authenticated")
    )


def upgrade() -> None:
    if not _is_postgres():
        return
    for statement in upgrade_statements():
        op.execute(statement)


def downgrade() -> None:
    return
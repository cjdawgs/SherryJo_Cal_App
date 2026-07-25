"""Row Level Security tests (tests 17-20 of the security review test plan).

These require a real PostgreSQL server; SQLite has no RLS. Point
``TEST_DATABASE_URL`` at a throwaway database (CI provides one) to run them.

Tests 17 and 20 cover the Layer-1 baseline shipped today: RLS enabled on every
table, and the PostgREST-facing roles stripped of every grant.

Tests 18 and 19 cover the Layer-2 least-privilege design (a dedicated
``app_user`` role driven by the ``app.user_id`` session GUC). They run as soon
as that role exists and skip until then, so the policies cannot land unverified.
"""

import os

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app.database import Base
from app.db_security import RLS_TABLES, enforce_row_level_security

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not TEST_DATABASE_URL,
    reason="Set TEST_DATABASE_URL to a PostgreSQL database to run the RLS tests",
)


@pytest.fixture(scope="module")
def pg_engine():
    engine = create_engine(TEST_DATABASE_URL)
    Base.metadata.create_all(bind=engine)

    with engine.connect() as conn:
        for role in ("anon", "authenticated"):
            conn.execute(
                text(
                    f"DO $$ BEGIN "
                    f"IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') "
                    f"THEN CREATE ROLE {role} NOLOGIN; END IF; END $$;"
                )
            )
            # Grant first, so the REVOKE under test has something to remove.
            conn.execute(text(f"GRANT USAGE ON SCHEMA public TO {role}"))
            conn.execute(
                text(f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {role}")
            )
        conn.commit()

    enforce_row_level_security(engine)

    yield engine

    engine.dispose()


# --------------------------------------------------
# 17. RLS is enabled on every application table
# --------------------------------------------------

def test_row_level_security_is_enabled_on_every_table(pg_engine):
    with pg_engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT c.relname, c.relrowsecurity "
                "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE n.nspname = 'public' AND c.relkind = 'r'"
            )
        ).all()

    enabled = {name: secured for name, secured in rows}

    unprotected = [
        table for table in RLS_TABLES if table in enabled and not enabled[table]
    ]
    assert not unprotected, f"Tables without RLS: {unprotected}"


def test_every_public_table_is_covered_by_the_rls_list(pg_engine):
    """A new table must be added to RLS_TABLES, not silently left exposed."""
    with pg_engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT c.relname FROM pg_class c "
                "JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE n.nspname = 'public' AND c.relkind = 'r' "
                "AND c.relname NOT LIKE 'alembic%'"
            )
        ).scalars().all()

    assert set(rows) - set(RLS_TABLES) == set()


# --------------------------------------------------
# 20. The public data-API roles have no grants left
# --------------------------------------------------

@pytest.mark.parametrize("role", ["anon", "authenticated"])
@pytest.mark.parametrize("privilege", ["SELECT", "INSERT", "UPDATE", "DELETE"])
def test_public_api_roles_have_no_table_privileges(pg_engine, role, privilege):
    with pg_engine.connect() as conn:
        for table in RLS_TABLES:
            granted = conn.execute(
                text("SELECT has_table_privilege(:role, :table, :privilege)"),
                {"role": role, "table": f"public.{table}", "privilege": privilege},
            ).scalar()

            assert granted is False, f"{role} still has {privilege} on {table}"


def test_default_privileges_do_not_re_expose_new_tables(pg_engine):
    with pg_engine.connect() as conn:
        defaults = conn.execute(
            text(
                "SELECT defaclacl::text FROM pg_default_acl d "
                "JOIN pg_namespace n ON n.oid = d.defaclnamespace "
                "WHERE n.nspname = 'public'"
            )
        ).scalars().all()

    for acl in defaults:
        assert "anon=" not in (acl or "")
        assert "authenticated=" not in (acl or "")


# --------------------------------------------------
# 18-19. Layer-2 policies (dedicated app_user role)
# --------------------------------------------------

def _app_user_url():
    password = os.getenv("APP_USER_PASSWORD")
    if not password or not TEST_DATABASE_URL:
        return None
    return make_url(TEST_DATABASE_URL).set(username="app_user", password=password)


def _app_user_exists(engine) -> bool:
    with engine.connect() as conn:
        return bool(
            conn.execute(
                text("SELECT 1 FROM pg_roles WHERE rolname = 'app_user'")
            ).scalar()
        )


@pytest.fixture
def app_user_engine(pg_engine):
    if not _app_user_exists(pg_engine):
        pytest.skip("Layer-2 app_user role is not provisioned yet")

    url = _app_user_url()
    if not url:
        pytest.skip("Set APP_USER_PASSWORD to run the Layer-2 policy tests")

    engine = create_engine(url)
    yield engine
    engine.dispose()


def test_owner_scoped_policy_hides_other_users_rows(app_user_engine, pg_engine):
    with pg_engine.connect() as conn:
        conn.execute(
            text(
                "INSERT INTO users (username, email, hashed_password, role) "
                "VALUES ('rls_a', 'rls_a@mail.test', 'x', 'staff'), "
                "       ('rls_b', 'rls_b@mail.test', 'x', 'staff') "
                "ON CONFLICT DO NOTHING"
            )
        )
        ids = conn.execute(
            text("SELECT id FROM users WHERE email IN ('rls_a@mail.test','rls_b@mail.test') ORDER BY id")
        ).scalars().all()
        conn.execute(
            text(
                "INSERT INTO events (title, start_time, owner_id) "
                "VALUES ('A event', now(), :a), ('B event', now(), :b)"
            ),
            {"a": ids[0], "b": ids[1]},
        )
        conn.commit()

    with app_user_engine.connect() as conn:
        conn.execute(text("SELECT set_config('app.user_id', :uid, false)"), {"uid": str(ids[0])})

        titles = conn.execute(text("SELECT title FROM events")).scalars().all()
        assert set(titles) == {"A event"}

        updated = conn.execute(text("UPDATE events SET title = 'hijacked'")).rowcount
        assert updated == 1  # only the caller's own row

        with pytest.raises(Exception):
            conn.execute(
                text("INSERT INTO events (title, start_time, owner_id) VALUES ('x', now(), :b)"),
                {"b": ids[1]},
            )
        conn.rollback()


def test_missing_session_identity_returns_no_rows(app_user_engine):
    with app_user_engine.connect() as conn:
        conn.execute(text("SELECT set_config('app.user_id', '', false)"))

        for table in RLS_TABLES:
            count = conn.execute(text(f"SELECT count(*) FROM {table}")).scalar()
            assert count == 0, f"{table} leaked rows without an identity"

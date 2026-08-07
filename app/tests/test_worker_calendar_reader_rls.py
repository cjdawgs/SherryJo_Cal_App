"""PostgreSQL proof for the least-privilege Worker calendar reader."""

import importlib.util
import os
from pathlib import Path
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError
from alembic.config import Config
from alembic.script import ScriptDirectory

from app.database import Base


TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "alembic" / "versions" / "k964e55bbb88_add_worker_calendar_reader.py"
MIGRATION_SPEC = importlib.util.spec_from_file_location("worker_calendar_reader_migration", MIGRATION_PATH)
assert MIGRATION_SPEC and MIGRATION_SPEC.loader
MIGRATION = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION)


def test_worker_reader_migration_is_in_single_alembic_head_chain():
    script = ScriptDirectory.from_config(Config(str(ROOT / "alembic.ini")))
    heads = script.get_heads()

    assert len(heads) == 1
    head_revision = heads[0]
    lineage = {revision.revision for revision in script.walk_revisions(base="base", head=head_revision)}

    assert "ac983w33ppp77" in lineage
    assert set(script.get_revision("ac983w33ppp77").down_revision) == {"ab982v22ooo66", "bb981v22nnn55"}
    assert script.get_revision("bb981v22nnn55").down_revision == "aa980u11mmm44"
    assert script.get_revision("z979t00lll33").down_revision == "y978s99kkk22"
    assert script.get_revision("y978s99kkk22").down_revision == "x977r88jjj11"
    assert script.get_revision("x977r88jjj11").down_revision == "w976q77iii00"
    assert script.get_revision("w976q77iii00").down_revision == "v975p66hhh99"
    assert script.get_revision("v975p66hhh99").down_revision == "u974o55ggg88"
    assert script.get_revision("u974o55ggg88").down_revision == "t973n44fff77"
    assert script.get_revision("t973n44fff77").down_revision == "s972m33eee66"
    assert script.get_revision("s972m33eee66").down_revision == "r971l22ddd55"
    assert script.get_revision("r971l22ddd55").down_revision == "q970k11ccc44"
    assert script.get_revision("q970k11ccc44").down_revision == "p969j00bbb33"
    assert script.get_revision("p969j00bbb33").down_revision == "o968i99aaa22"
    assert script.get_revision("o968i99aaa22").down_revision == "n967h88fff11"
    assert script.get_revision("n967h88fff11").down_revision == "m966g77eee00"
    assert script.get_revision("m966g77eee00").down_revision == "l965f66ccc99"
    assert script.get_revision("l965f66ccc99").down_revision == "k964e55bbb88"


def test_worker_reader_migration_grants_only_approved_projection_columns_without_password():
    statements = "\n".join(MIGRATION.upgrade_statements()).upper()
    grants = "\n".join(
        statement for statement in MIGRATION.upgrade_statements()
        if statement.strip().upper().startswith("GRANT")
    ).upper()

    assert "PASSWORD" not in statements
    assert "GRANT SELECT (" in statements
    assert "ON TABLE PUBLIC.EVENTS TO WORKER_CALENDAR_READER" in statements
    assert "GRANT SELECT ON" not in statements
    assert "GRANT ALL" not in statements
    assert "OAUTH_ACCOUNTS" not in grants
    assert "ACCESS_TOKEN" not in grants
    assert "REFRESH_TOKEN" not in grants
    assert "SECURITY_BARRIER = TRUE" in statements
    assert "ALTER ROLE WORKER_CALENDAR_READER" not in statements
    assert "ROLSUPER" in statements
    assert "ROLBYPASSRLS" in statements


@pytest.fixture(scope="module")
def worker_rls_engine():
    if not TEST_DATABASE_URL:
        pytest.skip("Set TEST_DATABASE_URL to a throwaway PostgreSQL database to run Worker RLS tests")
    engine = create_engine(TEST_DATABASE_URL)
    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        conn.exec_driver_sql("ALTER TABLE public.events ENABLE ROW LEVEL SECURITY")
        for statement in MIGRATION.upgrade_statements():
            conn.exec_driver_sql(statement)
    yield engine
    engine.dispose()


@pytest.fixture(scope="module")
def worker_rls_rows(worker_rls_engine):
    suffix = uuid.uuid4().hex
    with worker_rls_engine.begin() as conn:
        user_ids = conn.execute(
            text(
                "INSERT INTO users (username, email, hashed_password, role) "
                "VALUES (:username_a, :email_a, 'x', 'staff'), "
                "       (:username_b, :email_b, 'x', 'staff') "
                "RETURNING id"
            ),
            {
                "username_a": f"worker_rls_a_{suffix}",
                "email_a": f"worker_rls_a_{suffix}@mail.test",
                "username_b": f"worker_rls_b_{suffix}",
                "email_b": f"worker_rls_b_{suffix}@mail.test",
            },
        ).scalars().all()
        conn.execute(
            text(
                "INSERT INTO events "
                "(title, start_time, owner_id, source, account_email, color_enabled) "
                "VALUES (:title_a, now(), :user_a, 'local', 'local', false), "
                "       (:title_b, now(), :user_b, 'local', 'local', false)"
            ),
            {
                "title_a": f"Worker A {suffix}",
                "title_b": f"Worker B {suffix}",
                "user_a": user_ids[0],
                "user_b": user_ids[1],
            },
        )
        conn.execute(
            text(
                "INSERT INTO oauth_accounts "
                "(user_id, provider, account_email, access_token, status, is_service_provider, "
                " sync_frequency_minutes, sync_range_days) "
                "VALUES (:user_a, 'gmail', :email_a, 'token-a', 'ok', false, 5, 30), "
                "       (:user_b, 'outlook', :email_b, '__REAUTH_REQUIRED__', 'error', false, 5, 30)"
            ),
            {
                "user_a": user_ids[0],
                "email_a": f"worker_rls_a_{suffix}@mail.test",
                "user_b": user_ids[1],
                "email_b": f"worker_rls_b_{suffix}@mail.test",
            },
        )
    return {
        "user_a": user_ids[0],
        "title_a": f"Worker A {suffix}",
        "account_key_a": f"google:worker_rls_a_{suffix}@mail.test",
    }


def _set_worker_role(conn, user_id: object) -> None:
    conn.execute(text("SET LOCAL ROLE worker_calendar_reader"))
    conn.execute(
        text("SELECT set_config('app.user_id', :user_id, true)"),
        {"user_id": str(user_id)},
    )


def test_worker_role_is_passwordless_and_cannot_bypass_rls(worker_rls_engine):
    with worker_rls_engine.connect() as conn:
        role = conn.execute(
            text(
                "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, "
                "rolinherit, rolbypassrls, rolpassword "
                "FROM pg_authid WHERE rolname = 'worker_calendar_reader'"
            )
        ).one()

    assert role == (True, False, False, False, False, False, None)


def test_worker_role_reads_only_the_verified_users_events(worker_rls_engine, worker_rls_rows):
    with worker_rls_engine.connect() as conn:
        with conn.begin():
            _set_worker_role(conn, worker_rls_rows["user_a"])
            titles = conn.execute(text("SELECT title FROM events")).scalars().all()

    assert titles == [worker_rls_rows["title_a"]]


def test_worker_role_reads_only_credential_free_status_for_verified_user(
    worker_rls_engine,
    worker_rls_rows,
):
    with worker_rls_engine.connect() as conn:
        with conn.begin():
            _set_worker_role(conn, worker_rls_rows["user_a"])
            statuses = conn.execute(
                text("SELECT account_key, account_status FROM worker_calendar_account_status")
            ).all()

    assert statuses == [(worker_rls_rows["account_key_a"], "ok")]


@pytest.mark.parametrize("identity", ["", "not-a-number", "0", "99999999999999999999"])
def test_worker_role_missing_or_malformed_identity_reads_nothing(
    worker_rls_engine,
    worker_rls_rows,
    identity,
):
    with worker_rls_engine.connect() as conn:
        with conn.begin():
            _set_worker_role(conn, identity)
            count = conn.execute(text("SELECT count(*) FROM events")).scalar_one()

    assert count == 0


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE events SET title = 'forbidden'",
        "DELETE FROM events",
        "INSERT INTO events (title, start_time, owner_id) VALUES ('forbidden', now(), 1)",
        "CREATE TABLE public.worker_forbidden (id integer)",
        "SELECT access_token FROM oauth_accounts",
    ],
)
def test_worker_role_cannot_write_read_credentials_or_escalate(worker_rls_engine, statement):
    with worker_rls_engine.connect() as conn:
        with pytest.raises(DBAPIError):
            with conn.begin():
                conn.execute(text("SET LOCAL ROLE worker_calendar_reader"))
                conn.execute(text(statement))


def test_worker_login_identity_cannot_assume_postgres_role(worker_rls_engine):
    with worker_rls_engine.connect() as conn:
        with pytest.raises(DBAPIError):
            with conn.begin():
                conn.execute(text("SET LOCAL SESSION AUTHORIZATION worker_calendar_reader"))
                conn.execute(text("SET ROLE postgres"))


def test_worker_role_has_no_unapproved_table_grants(worker_rls_engine):
    with worker_rls_engine.connect() as conn:
        table_grants = conn.execute(
            text(
                "SELECT table_name, privilege_type FROM information_schema.role_table_grants "
                "WHERE grantee = 'worker_calendar_reader' ORDER BY table_name, privilege_type"
            )
        ).all()
        column_grants = conn.execute(
            text(
                "SELECT table_name, column_name, privilege_type "
                "FROM information_schema.role_column_grants "
                "WHERE grantee = 'worker_calendar_reader' "
                "ORDER BY table_name, column_name, privilege_type"
            )
        ).all()

    assert table_grants == []
    assert column_grants == sorted([
        *(("events", column, "SELECT") for column in MIGRATION.EVENT_READ_COLUMNS),
        (MIGRATION.ACCOUNT_STATUS_VIEW, "account_key", "SELECT"),
        (MIGRATION.ACCOUNT_STATUS_VIEW, "account_status", "SELECT"),
    ])
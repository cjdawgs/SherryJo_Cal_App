import json
import os
import uuid

from dotenv import dotenv_values
from sqlalchemy.engine import make_url


def _isolate_database_environment(monkeypatch):
    for key in (
        "DATABASE_URL",
        "REQUIRE_DB_KIND",
        "DISABLE_SQLITE_FALLBACK",
        "DB_TYPE",
        "DB_USER",
        "DB_PASSWORD",
        "DB_HOST",
        "DB_NAME",
        "DB_PORT",
        "DB_SSL_MODE",
        "DB_PROFILES",
    ):
        monkeypatch.setenv(key, os.getenv(key, ""))


def _admin_headers(client):
    identity = uuid.uuid4().hex[:12]
    email = f"database_admin_{identity}@test.com"
    password = "AdminPass123"
    registered = client.post("/auth/register", json={
        "username": f"database_admin_{identity}",
        "email": email,
        "password": password,
        "role": "admin",
    })
    assert registered.status_code == 200
    logged_in = client.post("/auth/login", json={"email": email, "password": password})
    assert logged_in.status_code == 200
    return {"Authorization": f"Bearer {logged_in.json()['access_token']}"}


def test_database_config_hides_saved_connection_secrets(client, monkeypatch):
    from app.routers import admin as admin_router

    connection_url = "postgresql://saved_user:top-secret-password@db.example.test/appdb?sslmode=require"
    monkeypatch.setattr(admin_router.database_module, "DATABASE_URL", connection_url)
    monkeypatch.setenv("DATABASE_URL", connection_url)
    monkeypatch.setenv("REQUIRE_DB_KIND", "postgres")
    monkeypatch.setattr(admin_router, "_database_profiles", lambda: [{
        "title": "Neon Test",
        "database_url": connection_url,
        "database_user": "saved_user",
        "database_password": "top-secret-password",
        "database_host": "db.example.test",
        "database_port": "5432",
        "database_name": "appdb",
        "ssl_mode": "require",
    }])
    monkeypatch.setattr(
        admin_router,
        "_active_database_connection_status",
        lambda: {"connected": True, "message": "Active database connection verified."},
    )

    response = client.get("/admin/system/database-config", headers=_admin_headers(client))
    assert response.status_code == 200
    body = response.json()
    serialized = response.text

    assert "top-secret-password" not in serialized
    assert connection_url not in serialized
    assert "database_url" not in body
    assert "preferred_postgres_url" not in body
    assert "database_url" not in body["profiles"][0]
    assert "database_password" not in body["profiles"][0]
    assert body["profiles"][0]["has_saved_credentials"] is True
    assert body["live_database_confirmed"] is True
    assert body["is_connected_to_postgres"] is True
    assert body["active_database_copy_source"]["key"] == "__active_database__"
    assert connection_url not in json.dumps(body["active_database_copy_source"])
    assert "active_database_source" not in body


def test_database_test_does_not_echo_candidate_url_or_credentials(client, monkeypatch):
    from app.routers import admin as admin_router

    connection_url = "postgresql://test_user:secret-for-test@db.example.test/testdb?sslmode=require"
    monkeypatch.setattr(
        admin_router,
        "_test_database_url",
        lambda candidate: {"ok": candidate == connection_url, "message": "Database connection verified."},
    )

    response = client.post(
        "/admin/system/database-config/test",
        headers=_admin_headers(client),
        json={"database_mode": "postgres", "database_url": connection_url},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert connection_url not in response.text
    assert "secret-for-test" not in response.text
    assert "database_url" not in body


def test_postgres_fields_encode_special_characters_in_credentials():
    from app.routers.admin import _normalize_database_url

    normalized = _normalize_database_url(
        "postgres",
        None,
        database_user="test-user",
        database_password="p@ss:/word",
        database_host="db.example.test",
        database_name="calendar",
        database_port="5432",
        ssl_mode="require",
    )

    parsed = make_url(normalized)
    assert parsed.username == "test-user"
    assert parsed.password == "p@ss:/word"
    assert parsed.host == "db.example.test"
    assert parsed.database == "calendar"
    assert parsed.query["sslmode"] == "require"


def test_connecting_saved_profile_reuses_full_connection_url(monkeypatch):
    from app.routers import admin as admin_router

    saved_url = "postgresql://saved_user:saved-secret@db.example.test/calendar?sslmode=require&channel_binding=require"
    monkeypatch.setattr(admin_router, "_database_profiles", lambda: [{
        "title": "Neon Test",
        "database_url": saved_url,
        "database_user": "saved_user",
        "database_password": "saved-secret",
        "database_host": "db.example.test",
        "database_port": "5432",
        "database_name": "calendar",
        "ssl_mode": "require",
    }])

    normalized, _fields = admin_router._resolve_database_config(
        admin_router.DatabaseRuntimeConfigUpdate(
            provider_title="Neon Test",
            database_mode="postgres",
            database_host="db.example.test",
            database_port="5432",
            database_name="calendar",
            database_user="saved_user",
            ssl_mode="require",
        )
    )

    assert make_url(normalized).query == make_url(saved_url).query
    assert make_url(normalized).username == make_url(saved_url).username
    assert make_url(normalized).password == make_url(saved_url).password


def test_local_environment_values_round_trip_dotenv_special_characters(monkeypatch, tmp_path):
    from app.routers import admin as admin_router

    app_directory = tmp_path / "app"
    app_directory.mkdir()
    monkeypatch.setattr(admin_router, "BASE_DIR", str(app_directory))
    profile_json = json.dumps([{
        "database_password": "pa$$${SECRET}'#\\word",
    }])

    env_file = admin_router._write_local_environment_values({"DB_PROFILES": profile_json})

    assert json.loads(dotenv_values(env_file)["DB_PROFILES"]) == json.loads(profile_json)


def test_copy_sequence_reset_tracks_imported_primary_key_values():
    from app.routers.admin import _reset_postgres_sequences

    class Result:
        def __init__(self, value):
            self.value = value

        def scalar(self):
            return self.value

    class Connection:
        def __init__(self):
            self.sequence_values = []

        def execute(self, statement, params=None):
            sql = str(statement)
            if "pg_get_serial_sequence" in sql:
                return Result(f"public.{params['table_name']}_id_seq")
            if "SELECT MAX" in sql:
                table = sql.split('FROM "')[1].split('"')[0]
                return Result({"users": 12, "events": None}[table])
            if "setval" in sql:
                self.sequence_values.append(params)
            return Result(None)

    class Inspector:
        def get_table_names(self):
            return ["users", "events"]

        def get_pk_constraint(self, _table):
            return {"constrained_columns": ["id"]}

    connection = Connection()
    reset_count = _reset_postgres_sequences(connection, Inspector(), ("users", "events"))

    assert reset_count == 2
    assert connection.sequence_values == [
        {"sequence": "public.users_id_seq", "value": 12, "is_called": True},
        {"sequence": "public.events_id_seq", "value": 1, "is_called": False},
    ]


def test_saved_profile_stays_server_side_and_is_available_immediately(
    monkeypatch, tmp_path
):
    from app.routers import admin as admin_router

    app_directory = tmp_path / "app"
    app_directory.mkdir()
    _isolate_database_environment(monkeypatch)
    monkeypatch.setattr(admin_router, "BASE_DIR", str(app_directory))
    monkeypatch.setattr(admin_router, "is_production_environment", lambda: False)
    monkeypatch.setenv("DB_PROFILES", "[]")

    saved = admin_router._persist_runtime_database_config(
        "postgresql://profile_user:profile-secret@db.example.test/calendar?sslmode=require",
        "postgres",
        False,
        provider_title="Neon Test",
        database_user="profile_user",
        database_password="profile-secret",
        database_host="db.example.test",
        database_name="calendar",
        ssl_mode="require",
        database_port="5432",
    )

    assert "profile-secret" not in json.dumps(saved)
    assert "database_url" not in saved["profiles"][0]
    assert "database_password" not in saved["profiles"][0]
    assert saved["profiles"][0]["has_saved_credentials"] is True
    assert json.loads(os.environ["DB_PROFILES"])[0]["database_password"] == "profile-secret"
    assert (tmp_path / ".env").exists()
    assert not (app_directory / ".env").exists()


def test_save_profile_initializes_schema_without_switching_active_database(
    client, monkeypatch, tmp_path
):
    from app.routers import admin as admin_router

    class FakeEngine:
        def __init__(self):
            self.disposed = False

        def dispose(self):
            self.disposed = True

    _isolate_database_environment(monkeypatch)
    app_directory = tmp_path / "app"
    app_directory.mkdir()
    monkeypatch.setattr(admin_router, "BASE_DIR", str(app_directory))
    monkeypatch.setattr(admin_router, "is_production_environment", lambda: False)
    monkeypatch.setenv("DB_PROFILES", "[]")
    monkeypatch.setattr(
        admin_router,
        "_test_database_url",
        lambda _url: {"ok": True, "message": "Database connection verified."},
    )
    target_engine = FakeEngine()
    monkeypatch.setattr(admin_router, "_create_connected_database_engine", lambda _url: target_engine)
    initialized_engines = []
    monkeypatch.setattr(
        admin_router.Base.metadata,
        "create_all",
        lambda bind: initialized_engines.append(bind),
    )
    current_url = admin_router.database_module.DATABASE_URL
    monkeypatch.setenv("DATABASE_URL", current_url)

    connection_url = "postgresql://profile_user:profile-secret@db.example.test/calendar?sslmode=require"
    response = client.post(
        "/admin/system/database-config/profile",
        headers=_admin_headers(client),
        json={
            "provider_title": "Neon Test",
            "database_mode": "postgres",
            "database_url": connection_url,
        },
    )
    assert response.status_code == 200
    body = response.json()

    assert body["schema_initialized"] is True
    assert body["saved"]["title"] == "Neon Test"
    assert "profile-secret" not in response.text
    assert connection_url not in response.text
    assert initialized_engines == [target_engine]
    assert target_engine.disposed is True
    assert admin_router.database_module.DATABASE_URL == current_url
    assert os.environ["DATABASE_URL"] == current_url


def test_copy_accepts_active_sqlite_as_source_and_saved_postgres_target(
    client, monkeypatch
):
    from app.routers import admin as admin_router

    active_url = "sqlite:///./app.db"
    target_url = "postgresql://target:secret@db.example.test/calendar"
    monkeypatch.setattr(admin_router.database_module, "DATABASE_URL", active_url)
    monkeypatch.setattr(admin_router, "_database_profiles", lambda: [{
        "title": "Neon Test",
        "database_url": target_url,
    }])
    copied_from = []
    monkeypatch.setattr(
        admin_router,
        "_copy_critical_database_data",
        lambda source, target: copied_from.append((source, target)) or {"users": {"copied": 1}},
    )

    response = client.post(
        "/admin/system/database-config/copy",
        headers=_admin_headers(client),
        json={"source_provider": "__active_database__", "target_provider": "Neon Test"},
    )
    assert response.status_code == 200
    assert copied_from == [(active_url, target_url)]


def test_database_copy_error_does_not_expose_connection_details(client, monkeypatch):
    from app.routers import admin as admin_router

    monkeypatch.setattr(admin_router.database_module, "DATABASE_URL", "sqlite:///./app.db")
    monkeypatch.setattr(admin_router, "_database_profiles", lambda: [{
        "title": "Neon Test",
        "database_url": "postgresql://user:private-secret@db.example.test/calendar",
    }])

    def fail_copy(_source, _target):
        raise RuntimeError("postgresql://user:private-secret@db.example.test/calendar failed")

    monkeypatch.setattr(admin_router, "_copy_critical_database_data", fail_copy)

    response = client.post(
        "/admin/system/database-config/copy",
        headers=_admin_headers(client),
        json={"source_provider": "__active_database__", "target_provider": "Neon Test"},
    )

    assert response.status_code == 502
    assert "private-secret" not in response.text
    assert "db.example.test" not in response.text


def test_disconnect_switches_origin_to_sqlite_and_persists_in_repo_env(
    client, monkeypatch, tmp_path
):
    from app.routers import admin as admin_router
    import app.database as database_module

    class FakeEngine:
        def __init__(self):
            self.disposed = False

        def dispose(self):
            self.disposed = True

    original_engine = FakeEngine()
    replacement_engine = FakeEngine()
    app_directory = tmp_path / "app"
    app_directory.mkdir()
    _isolate_database_environment(monkeypatch)
    monkeypatch.setattr(admin_router, "DATABASE_URL", admin_router.DATABASE_URL)
    monkeypatch.setattr(database_module, "DATABASE_URL", database_module.DATABASE_URL)
    monkeypatch.setattr(database_module, "SessionLocal", database_module.SessionLocal)
    monkeypatch.setattr(admin_router, "BASE_DIR", str(app_directory))
    monkeypatch.setattr(admin_router, "is_production_environment", lambda: False)
    monkeypatch.setattr(
        admin_router,
        "_test_database_url",
        lambda _url: {"ok": True, "message": "Database connection verified."},
    )
    monkeypatch.setattr(
        admin_router,
        "_create_connected_database_engine",
        lambda _url: replacement_engine,
    )
    monkeypatch.setattr(admin_router, "sessionmaker", lambda **_kwargs: "new-session-factory")
    monkeypatch.setattr(admin_router, "engine", original_engine)
    monkeypatch.setattr(database_module, "engine", original_engine)
    monkeypatch.setenv("DATABASE_URL", "postgresql://old:secret@db.example.test/app")
    monkeypatch.setenv("REQUIRE_DB_KIND", "postgres")

    response = client.post(
        "/admin/system/database-config/disconnect",
        headers=_admin_headers(client),
    )
    assert response.status_code == 200
    body = response.json()

    assert body["ok"] is True
    assert "PostgreSQL disconnected" in body["message"]
    assert "database_url" not in body["saved"]
    assert database_module.DATABASE_URL == "sqlite:///./app.db"
    assert database_module.engine is replacement_engine
    assert original_engine.disposed is True
    env_file = tmp_path / ".env"
    assert env_file.exists()
    assert dotenv_values(env_file)["DATABASE_URL"] == "sqlite:///./app.db"
    assert env_file.stat().st_mode & 0o777 == 0o600

"""Authorization, ownership and credential-exposure regression tests.

Covers tests 1-14 of the security review test plan:
authentication coverage, role enforcement, cross-user isolation, and the
guarantee that stored OAuth credentials never leave the API.
"""

import os

import pytest

from app.main import app
from app.models import Event, Note, OAuthAccount, TVDiagLog
from app.routers.admin import REDACTED_COLUMNS, REDACTED_PLACEHOLDER, redact_row
from app.utils.crypto import (
    TokenEncryptionError,
    reset_cipher_cache,
    seal,
    unseal,
)

# Routes that legitimately serve unauthenticated traffic.
PUBLIC_PATHS = {
    "/",
    "/health",
    "/favicon.ico",
    "/openapi.json",
    "/docs",
    "/docs/oauth2-redirect",
    "/redoc",
    "/auth/register",
    "/auth/login",
    "/tv/dashboard",
    "/login",          # HTML shell; the API behind it is authenticated
    "/calendar-ui",    # HTML shell; the API behind it is authenticated
    "/health/schema",  # liveness probe: table presence only, no data
    "/tv/kiosk",       # authenticates via a signed token in the query string
    "/tv/pair",        # authenticates via a one-time pairing code
    "/admin/ui",
    "/admin",
    "/accounts/ui",
    "/ms/login",
    "/ms/callback",
    "/google/login",
    "/auth/google/callback",
    "/schema-health",
}

ADMIN_PATHS = [
    ("GET", "/admin/system/overview"),
    ("GET", "/admin/system/current-user-failures-today"),
    ("GET", "/admin/system/current-user-failure-history?start_date=2026-07-01&end_date=2026-07-02"),
    ("GET", "/admin/system/tv-stale-refresh-summary?hours=24&limit=50"),
    ("GET", "/admin/system/table/users/rows"),
    ("GET", "/admin/users"),
    ("GET", "/admin/providers"),
    ("GET", "/admin/maintenance/orphans"),
    ("GET", "/users/"),
]


def _authenticated_routes():
    for route in app.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", None) or set()

        if not path or path in PUBLIC_PATHS:
            continue
        if path.startswith("/static") or "{" in path:
            continue

        for method in sorted(methods & {"GET", "POST", "PUT", "PATCH", "DELETE"}):
            yield method, path


# --------------------------------------------------
# 1. Every non-public route requires authentication
# --------------------------------------------------

def test_all_routes_require_authentication(client):
    unprotected = []

    for method, path in _authenticated_routes():
        response = client.request(method, path)
        if response.status_code not in (401, 403):
            unprotected.append(f"{method} {path} -> {response.status_code}")

    assert not unprotected, f"Routes reachable without a token: {unprotected}"


# --------------------------------------------------
# 2. Admin routes reject staff and accept admin
# --------------------------------------------------

@pytest.mark.parametrize("method,path", ADMIN_PATHS)
def test_admin_routes_reject_staff(client, auth_headers, method, path):
    assert client.request(method, path, headers=auth_headers).status_code == 403


@pytest.mark.parametrize("method,path", ADMIN_PATHS)
def test_admin_routes_accept_admin(client, admin_headers, method, path):
    assert client.request(method, path, headers=admin_headers).status_code == 200


# --------------------------------------------------
# 3. Admin registration requires the setup code
# --------------------------------------------------

def test_admin_registration_requires_setup_code(client, monkeypatch):
    # The router waives the check while pytest is running; drop the marker so
    # the production path is what gets exercised.
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setenv("ADMIN_SETUP_CODE", "correct-horse")

    payload = {
        "username": "escalate",
        "email": "escalate@test.com",
        "password": "pass123",
        "role": "admin",
    }

    assert client.post("/auth/register", json=payload).status_code == 403
    assert client.post(
        "/auth/register", json={**payload, "admin_setup_code": "wrong"}
    ).status_code == 403

    accepted = client.post(
        "/auth/register", json={**payload, "admin_setup_code": "correct-horse"}
    )
    assert accepted.status_code == 200
    assert accepted.json()["role"] == "admin"


def test_admin_registration_blocked_when_setup_code_unset(client, monkeypatch):
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.delenv("ADMIN_SETUP_CODE", raising=False)

    response = client.post("/auth/register", json={
        "username": "escalate2",
        "email": "escalate2@test.com",
        "password": "pass123",
        "role": "admin",
        "admin_setup_code": "anything",
    })

    assert response.status_code == 403


def test_runtime_token_encryption_key_endpoint_rejects_staff(client, auth_headers):
    response = client.post(
        "/admin/system/token-encryption-key/runtime",
        headers=auth_headers,
        json={"token_encryption_key": "not-a-real-key"},
    )
    assert response.status_code == 403


# --------------------------------------------------
# 4. Staff cannot escalate their own role
# --------------------------------------------------

def test_staff_cannot_change_own_role(client, user_a):
    user_id, headers = user_a

    response = client.put(
        f"/admin/users/{user_id}",
        json={"role": "admin"},
        headers=headers,
    )

    assert response.status_code == 403
    assert client.get("/users/me", headers=headers).json()["role"] == "staff"


# --------------------------------------------------
# 5-8. Cross-user ownership isolation
# --------------------------------------------------

def _create_event(client, headers, title="Owned event"):
    response = client.post("/calendar/event", json={
        "title": title,
        "start_time": "2026-05-01T10:00:00Z",
        "end_time": "2026-05-01T11:00:00Z",
    }, headers=headers)
    assert response.status_code == 200
    return response.json()["event"]["id"]


def test_events_are_not_readable_or_writable_across_users(client, user_a, user_b):
    _a_id, headers_a = user_a
    _b_id, headers_b = user_b

    event_id = _create_event(client, headers_a)

    assert client.put(
        f"/calendar/event/{event_id}", json={"title": "hijacked"}, headers=headers_b
    ).status_code == 404
    assert client.delete(
        f"/calendar/event/{event_id}", headers=headers_b
    ).status_code == 404

    listed = client.get("/events/", headers=headers_b).json()
    assert all(item["id"] != event_id for item in listed)


def test_tasks_are_not_listed_across_users(client, user_a, user_b):
    _a_id, headers_a = user_a
    _b_id, headers_b = user_b

    created = client.post(
        "/tasks/", json={"title": "A's task"}, headers=headers_a
    )
    assert created.status_code == 200

    assert client.get("/tasks/", headers=headers_b).json() == []


def test_date_sticky_notes_are_isolated(client, user_a, user_b):
    _a_id, headers_a = user_a
    _b_id, headers_b = user_b

    client.put(
        "/calendar/date-sticky/2026-05-01",
        json={"sticky_notes": [{"content": "A private note"}]},
        headers=headers_a,
    )

    fetched = client.get("/calendar/date-sticky/2026-05-01", headers=headers_b).json()
    assert fetched["item"]["sticky_notes"] == []

    client.put(
        "/calendar/date-sticky/2026-05-01",
        json={"sticky_notes": [{"content": "B overwrite"}]},
        headers=headers_b,
    )

    still_a = client.get("/calendar/date-sticky/2026-05-01", headers=headers_a).json()
    contents = [note.get("content") for note in still_a["item"]["sticky_notes"]]
    assert contents == ["A private note"]


def test_tag_colors_are_isolated(client, user_a, user_b):
    _a_id, headers_a = user_a
    _b_id, headers_b = user_b

    client.put(
        "/calendar/tag-colors",
        json={"settings": [{"tag_key": "listing", "label": "Listing", "color": "#123456", "enabled": True}]},
        headers=headers_a,
    )

    b_settings = client.get("/calendar/tag-colors", headers=headers_b).json()
    keys = {item.get("tag_key") for item in b_settings.get("settings", [])}
    assert "listing" not in keys or all(
        item.get("color") != "#123456"
        for item in b_settings.get("settings", [])
        if item.get("tag_key") == "listing"
    )


# --------------------------------------------------
# 9. OAuth accounts are not reachable across users
# --------------------------------------------------

def _create_oauth_account(db, user_id, provider="google"):
    account = OAuthAccount(
        user_id=user_id,
        provider=provider,
        account_email=f"{provider}-{user_id}@mail.test",
        access_token="ya29.super-secret-access-token",
        refresh_token="1//super-secret-refresh-token",
    )
    db.add(account)
    db.commit()
    db.refresh(account)
    return account


def test_oauth_accounts_are_isolated(client, db, user_a, user_b):
    a_id, headers_a = user_a
    _b_id, headers_b = user_b

    account = _create_oauth_account(db, a_id)

    assert client.get("/accounts", headers=headers_b).json() == []
    assert client.delete(f"/accounts/{account.id}", headers=headers_b).status_code == 404
    assert client.put(
        f"/accounts/{account.id}/color", json={"color": "#ffffff"}, headers=headers_b
    ).status_code == 404

    mine = client.get("/accounts", headers=headers_a).json()
    assert [item["id"] for item in mine] == [account.id]


# --------------------------------------------------
# 10. Notes are scoped through event ownership
# --------------------------------------------------

def test_notes_are_scoped_to_event_owner(client, db, user_a, user_b):
    a_id, headers_a = user_a
    _b_id, headers_b = user_b

    event_id = _create_event(client, headers_a, title="Event with note")

    db.add(Note(date="2026-05-01", content="A private note", event_id=event_id))
    db.commit()

    assert client.get(
        "/notes/", params={"date": "2026-05-01"}, headers=headers_b
    ).json() == []

    hijack = client.post("/notes/", json={
        "date": "2026-05-01",
        "content": "B overwrite",
        "event_id": event_id,
    }, headers=headers_b)
    assert hijack.status_code == 404

    a_notes = client.get(
        "/notes/", params={"date": "2026-05-01"}, headers=headers_a
    ).json()
    assert [note["content"] for note in a_notes] == ["A private note"]


# --------------------------------------------------
# 11. TV diagnostics are scoped to the caller
# --------------------------------------------------

def test_tv_diag_returns_only_own_entries(client, db, user_a, user_b):
    a_id, _headers_a = user_a
    b_id, headers_b = user_b

    db.add(TVDiagLog(user_id=a_id, event="A_EVENT", device_id="tv-a"))
    db.add(TVDiagLog(user_id=b_id, event="B_EVENT", device_id="tv-b"))
    db.commit()

    entries = client.get("/tv/diag", headers=headers_b).json()["entries"]

    assert {entry["user_id"] for entry in entries} == {b_id}
    assert all(entry["event"] != "A_EVENT" for entry in entries)


def test_tv_diag_fleet_wide_scope_requires_admin(client, auth_headers, admin_headers):
    assert client.get(
        "/tv/diag", params={"scope": "all"}, headers=auth_headers
    ).status_code == 403
    assert client.get(
        "/tv/diag", params={"scope": "all"}, headers=admin_headers
    ).status_code == 200


# --------------------------------------------------
# 12. The cross-user debug counter is gone
# --------------------------------------------------

def test_debug_db_count_route_removed(client, auth_headers):
    assert client.get("/calendar/debug/db-count", headers=auth_headers).status_code == 404
    assert not any(
        getattr(route, "path", "") == "/calendar/debug/db-count" for route in app.routes
    )


# --------------------------------------------------
# 13-14. Stored credentials never leave the API
# --------------------------------------------------

def test_account_payloads_never_expose_credentials(client, db, user_a):
    a_id, headers_a = user_a
    _create_oauth_account(db, a_id)

    for path in ("/accounts", "/accounts/sync-status", "/accounts/stats/by-provider"):
        body = client.get(path, headers=headers_a).text
        assert "ya29.super-secret-access-token" not in body
        assert "1//super-secret-refresh-token" not in body
        assert "access_token" not in body
        assert "refresh_token" not in body


def test_admin_table_browser_redacts_credentials(client, db, admin_headers, user_a):
    a_id, _headers_a = user_a
    _create_oauth_account(db, a_id)

    payload = client.get(
        "/admin/system/table/oauth_accounts/rows", headers=admin_headers
    ).json()

    assert "access_token" in payload["redacted_columns"]
    assert "refresh_token" in payload["redacted_columns"]
    assert payload["limit"] <= 200

    for row in payload["rows"]:
        assert row["access_token"] == REDACTED_PLACEHOLDER
        assert row["refresh_token"] in (REDACTED_PLACEHOLDER, None)

    body = client.get(
        "/admin/system/table/oauth_accounts/rows", headers=admin_headers
    ).text
    assert "ya29.super-secret-access-token" not in body


def test_admin_table_browser_redacts_password_hashes(client, admin_headers):
    payload = client.get(
        "/admin/system/table/users/rows", headers=admin_headers
    ).json()

    assert "hashed_password" in payload["redacted_columns"]
    assert all(row["hashed_password"] == REDACTED_PLACEHOLDER for row in payload["rows"])


def test_redact_row_covers_every_sensitive_column():
    row = {column: "secret" for column in REDACTED_COLUMNS}
    row["account_email"] = "user@example.com"

    redacted = redact_row(row)

    assert set(value for key, value in redacted.items() if key in REDACTED_COLUMNS) == {
        REDACTED_PLACEHOLDER
    }
    assert redacted["account_email"] == "user@example.com"


# --------------------------------------------------
# Credential encryption
# --------------------------------------------------

@pytest.fixture
def encryption_key(monkeypatch):
    from cryptography.fernet import Fernet
    from app.config import settings

    key = Fernet.generate_key().decode()
    monkeypatch.setattr(settings, "token_encryption_key", key, raising=False)
    reset_cipher_cache()
    yield key
    reset_cipher_cache()


def test_seal_round_trips_and_hides_plaintext(encryption_key):
    sealed = seal("ya29.super-secret-access-token")

    assert sealed.startswith("v1:")
    assert "ya29.super-secret-access-token" not in sealed
    assert unseal(sealed) == "ya29.super-secret-access-token"


def test_seal_is_idempotent_and_passes_through_legacy_values(encryption_key):
    sealed = seal("token")

    assert seal(sealed) == sealed
    assert unseal("plaintext-legacy-token") == "plaintext-legacy-token"
    assert seal(None) is None
    assert seal("") == ""


def test_sentinels_are_never_sealed(encryption_key):
    assert seal("admin-placeholder-token") == "admin-placeholder-token"
    assert seal("__REAUTH_REQUIRED__") == "__REAUTH_REQUIRED__"


def test_unseal_fails_loudly_with_the_wrong_key(encryption_key, monkeypatch):
    from cryptography.fernet import Fernet
    from app.config import settings

    sealed = seal("token")

    monkeypatch.setattr(
        settings, "token_encryption_key", Fernet.generate_key().decode(), raising=False
    )
    reset_cipher_cache()

    with pytest.raises(TokenEncryptionError):
        unseal(sealed)


def test_stored_credentials_are_encrypted_at_rest(db, client, user_a, encryption_key):
    from sqlalchemy import text

    a_id, _headers = user_a
    account = _create_oauth_account(db, a_id)

    stored = db.execute(
        text("SELECT access_token, refresh_token FROM oauth_accounts WHERE id = :id"),
        {"id": account.id},
    ).first()

    assert stored[0].startswith("v1:")
    assert "ya29.super-secret-access-token" not in stored[0]
    assert stored[1].startswith("v1:")

    db.expire_all()
    reloaded = db.get(OAuthAccount, account.id)
    assert reloaded.access_token == "ya29.super-secret-access-token"
    assert reloaded.refresh_token == "1//super-secret-refresh-token"


def test_sentinel_lookups_still_work_at_the_sql_level(db, client, user_a, encryption_key):
    a_id, _headers = user_a

    placeholder = OAuthAccount(
        user_id=a_id,
        provider="google",
        account_email="provider@mail.test",
        access_token="admin-placeholder-token",
        is_service_provider=True,
    )
    db.add(placeholder)
    db.commit()

    found = (
        db.query(OAuthAccount)
        .filter(OAuthAccount.access_token == "admin-placeholder-token")
        .all()
    )

    assert [account.id for account in found] == [placeholder.id]


def test_production_configuration_requires_security_env_vars(monkeypatch):
    from app import config

    monkeypatch.setattr(config.settings, "token_encryption_key", None, raising=False)
    monkeypatch.delenv("ADMIN_SETUP_CODE", raising=False)
    monkeypatch.delenv("DISABLE_SQLITE_FALLBACK", raising=False)
    monkeypatch.delenv("REQUIRE_DB_KIND", raising=False)

    missing = config.missing_production_configuration()

    assert "token_encryption_key" in missing
    assert "ADMIN_SETUP_CODE" in missing
    assert any(item.startswith("DISABLE_SQLITE_FALLBACK") for item in missing)
    assert any(item.startswith("REQUIRE_DB_KIND") for item in missing)

    monkeypatch.setattr(config.settings, "token_encryption_key", "key", raising=False)
    monkeypatch.setenv("ADMIN_SETUP_CODE", "code")
    monkeypatch.setenv("DISABLE_SQLITE_FALLBACK", "1")
    monkeypatch.setenv("REQUIRE_DB_KIND", "postgres")

    assert config.missing_production_configuration() == []


def test_render_is_detected_as_production(monkeypatch):
    from app import config

    monkeypatch.delenv("ENV", raising=False)
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.setenv("RENDER", "true")

    assert config.is_production_environment() is True

    monkeypatch.delenv("RENDER")
    monkeypatch.setenv("RENDER_SERVICE_ID", "srv-123")

    assert config.is_production_environment() is True


def test_event_rows_are_owned_by_the_creating_user(client, db, user_a):
    a_id, headers_a = user_a
    event_id = _create_event(client, headers_a)

    assert db.get(Event, event_id).owner_id == a_id


@pytest.mark.skipif(
    os.getenv("CI") is None and os.getenv("RUN_ROUTE_AUDIT") is None,
    reason="Route audit runs in CI (set RUN_ROUTE_AUDIT=1 to run locally)",
)
def test_no_new_unauthenticated_routes_were_added(client):
    # Same assertion as test 1, pinned in CI so a new router cannot ship
    # without an authentication dependency.
    for method, path in _authenticated_routes():
        assert client.request(method, path).status_code in (401, 403), path

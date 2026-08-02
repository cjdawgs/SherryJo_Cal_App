import uuid
from datetime import datetime, timezone

from cryptography.fernet import Fernet

from app.config import settings
from app.models import DateStickyNote, Event, Note, OAuthAccount, Task, TVDiagLog, User
from app.utils.crypto import reset_cipher_cache, unseal
from app.utils.runtime_token_key_store import load_persisted_token_encryption_key


def _register_user(client, role="staff", password="pass12345"):
    ident = uuid.uuid4().hex[:10]
    email = f"{role}_{ident}@test.com"
    username = f"{role}_{ident}"

    res = client.post("/auth/register", json={
        "username": username,
        "email": email,
        "password": password,
        "role": role,
    })
    assert res.status_code == 200

    payload = res.json()
    return {
        "id": payload["id"],
        "email": email,
        "username": username,
        "password": password,
    }


def _login_headers(client, email, password):
    res = client.post("/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200
    token = res.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def _admin_headers(client):
    admin = _register_user(client, role="admin")
    return _login_headers(client, admin["email"], admin["password"])


def _staff_headers(client):
    staff = _register_user(client, role="staff")
    return _login_headers(client, staff["email"], staff["password"])


def test_admin_users_requires_admin_role(client):
    staff_headers = _staff_headers(client)

    denied = client.get("/admin/users", headers=staff_headers)
    assert denied.status_code == 403

    no_auth = client.get("/admin/users")
    assert no_auth.status_code in (401, 403)


def test_admin_users_crud_and_reset_flow(client):
    headers = _admin_headers(client)

    create_res = client.post("/admin/users", headers=headers, json={
        "email": "managed.user@test.com",
        "username": "managed_user",
        "role": "staff",
        "password": "StrongPass123",
    })
    assert create_res.status_code == 200
    created = create_res.json()
    assert created["email"] == "managed.user@test.com"
    assert created["username"] == "managed_user"
    assert created["role"] == "staff"
    assert isinstance(created["id"], int)

    user_id = created["id"]

    get_res = client.get(f"/admin/users/{user_id}", headers=headers)
    assert get_res.status_code == 200
    fetched = get_res.json()
    assert fetched["id"] == user_id

    update_res = client.put(f"/admin/users/{user_id}", headers=headers, json={
        "email": "managed.updated@test.com",
        "username": "managed_updated",
        "role": "admin",
    })
    assert update_res.status_code == 200
    updated = update_res.json()
    assert updated["email"] == "managed.updated@test.com"
    assert updated["username"] == "managed_updated"
    assert updated["role"] == "admin"

    reset_res = client.post(f"/admin/users/{user_id}/reset-password", headers=headers, json={
        "new_password": "NewStrongPass456",
    })
    assert reset_res.status_code == 200
    assert reset_res.json()["reset"] is True

    delete_res = client.delete(f"/admin/users/{user_id}", headers=headers)
    assert delete_res.status_code == 200
    assert delete_res.json() == {"deleted": True, "id": user_id}

    missing_res = client.get(f"/admin/users/{user_id}", headers=headers)
    assert missing_res.status_code == 404


def test_admin_providers_requires_admin_role(client):
    staff_headers = _staff_headers(client)

    denied = client.get("/admin/providers", headers=staff_headers)
    assert denied.status_code == 403


def test_admin_system_overview_requires_admin_role(client):
    staff_headers = _staff_headers(client)

    denied = client.get("/admin/system/overview", headers=staff_headers)
    assert denied.status_code == 403


def test_admin_system_overview_payload(client, monkeypatch):
    from app.routers import admin as admin_router

    current_sha = "a" * 40
    monkeypatch.setenv("RENDER_GIT_COMMIT", current_sha)
    monkeypatch.setattr(
        admin_router,
        "_fetch_github_latest_commit_probe",
        lambda repo, branch: {"commit": current_sha, "error": None, "error_code": None, "http_status": 200},
    )

    headers = _admin_headers(client)

    res = client.get("/admin/system/overview", headers=headers)
    assert res.status_code == 200

    payload = res.json()
    assert "database" in payload
    assert "tables" in payload
    assert "table_count" in payload
    assert "admin_operations" in payload

    assert isinstance(payload["tables"], list)
    assert payload["table_count"] == len(payload["tables"])

    db = payload["database"]
    assert "engine" in db
    assert "label" in db
    assert "database" in db
    assert "host" in db

    ops = payload["admin_operations"]
    assert isinstance(ops.get("users"), list)
    assert isinstance(ops.get("providers"), list)

    deployment = payload["deployment"]
    assert deployment["status"] == "synced"
    assert deployment["current_commit"] == current_sha
    assert deployment["github_latest_commit"] == current_sha
    assert deployment["github_error"] is None
    assert deployment["branch_url"]
    assert deployment["manual_deploy_available"] in {True, False}
    assert deployment["active_platform"] == "render"
    assert {platform["id"] for platform in deployment["platforms"]} == {"render", "cloudflare"}
    assert len(deployment["repository_controls"]["fetch_pull_targets"]) == 2


def test_admin_system_overview_detects_cloudflare_edge(client, monkeypatch):
    from app.routers import admin as admin_router
    from app import config

    current_sha = "d" * 40
    monkeypatch.setenv("RENDER_GIT_COMMIT", current_sha)
    monkeypatch.setattr(
        admin_router,
        "_fetch_github_latest_commit_probe",
        lambda repo, branch: {"commit": current_sha, "error": None, "error_code": None, "http_status": 200},
    )
    monkeypatch.setattr(config.settings, "PUBLIC_BASE_URLS", "https://canary.example.com")
    monkeypatch.setattr(config.settings, "EDGE_PROXY_SECRET", "trusted-edge-secret")

    headers = _admin_headers(client)
    headers.update({
        "x-sherryjo-edge": "cloudflare",
        "x-sherryjo-edge-auth": "trusted-edge-secret",
        "x-forwarded-host": "canary.example.com",
        "x-forwarded-proto": "https",
    })
    res = client.get("/admin/system/overview", headers=headers)

    assert res.status_code == 200
    deployment = res.json()["deployment"]
    assert deployment["active_platform"] == "cloudflare"
    assert deployment["active_platform_label"] == "Cloudflare edge / Render origin"
    assert "Cloudflare edge / Render origin" in deployment["message"]


def test_admin_system_overview_rejects_forged_cloudflare_marker(client):
    headers = _admin_headers(client)
    headers["x-sherryjo-edge"] = "cloudflare"

    res = client.get("/admin/system/overview", headers=headers)

    assert res.status_code == 200
    assert res.json()["deployment"]["active_platform"] == "render"


def test_admin_render_redeploy_endpoint_uses_hook(client, monkeypatch):
    from app.routers import admin as admin_router

    headers = _admin_headers(client)
    monkeypatch.setenv("RENDER_DEPLOY_HOOK_URL", "https://example.invalid/render-hook")

    class _FakeResponse:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return b"ok"

        def getcode(self):
            return 200

    monkeypatch.setattr(admin_router, "urlopen", lambda request, timeout=10: _FakeResponse())

    res = client.post("/admin/system/render/redeploy", headers=headers)
    assert res.status_code == 200

    payload = res.json()
    assert payload["triggered"] is True
    assert payload["status_code"] == 200
    assert payload["render_dashboard_url"]


def test_admin_cloudflare_redeploy_endpoint_uses_hook(client, monkeypatch):
    from app.routers import admin as admin_router

    headers = _admin_headers(client)
    monkeypatch.setenv("CLOUDFLARE_DEPLOY_HOOK_URL", "https://example.invalid/cloudflare-hook")

    class _FakeResponse:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return b"queued"

        def getcode(self):
            return 200

    monkeypatch.setattr(admin_router, "urlopen", lambda request, timeout=10: _FakeResponse())

    res = client.post("/admin/system/cloudflare/redeploy", headers=headers)
    assert res.status_code == 200
    assert res.json()["message"] == "Cloudflare deploy hook triggered."


def test_admin_git_commit_push_requires_current_admin_password(client, monkeypatch):
    from app.routers import admin as admin_router

    admin = _register_user(client, role="admin")
    headers = _login_headers(client, admin["email"], admin["password"])
    launched = []
    monkeypatch.setattr(admin_router, "_launch_git_commit_script", lambda: launched.append(True) or {"launched": True})

    denied = client.post(
        "/admin/system/github/commit-push",
        headers=headers,
        json={"password": "wrong-password"},
    )
    assert denied.status_code == 403
    assert launched == []

    allowed = client.post(
        "/admin/system/github/commit-push",
        headers=headers,
        json={"password": admin["password"]},
    )
    assert allowed.status_code == 200
    assert allowed.json()["launched"] is True
    assert launched == [True]


def test_admin_system_overview_flags_missing_token_key_when_credentials_encrypted(client, db, monkeypatch):
    from app.routers import admin as admin_router

    headers = _admin_headers(client)
    owner = _register_user(client, role="staff")

    db.add(OAuthAccount(
        user_id=owner["id"],
        provider="google",
        account_email="enc-warning@test.com",
        access_token="v1:fake-sealed-token",
        refresh_token="v1:fake-sealed-refresh",
    ))
    db.commit()

    monkeypatch.setattr(settings, "token_encryption_key", None, raising=False)
    monkeypatch.setenv("RENDER_GIT_COMMIT", "b" * 40)
    monkeypatch.setattr(
        admin_router,
        "_fetch_github_latest_commit_probe",
        lambda repo, branch: {"commit": "b" * 40, "error": None, "error_code": None, "http_status": 200},
    )

    res = client.get("/admin/system/overview", headers=headers)
    assert res.status_code == 200

    payload = res.json()
    security = payload.get("security") or {}
    assert security.get("encrypted_credentials_present") is True
    assert security.get("token_encryption_key_configured") is False
    assert security.get("missing_key_with_encrypted_credentials") is True


def test_admin_system_overview_reports_github_verification_failure_detail(client, monkeypatch):
    from app.routers import admin as admin_router

    headers = _admin_headers(client)
    monkeypatch.setenv("RENDER_GIT_COMMIT", "c" * 40)
    monkeypatch.setattr(
        admin_router,
        "_fetch_github_latest_commit_probe",
        lambda repo, branch: {"commit": None, "error": "Timed out contacting GitHub.", "error_code": "timeout", "http_status": None},
    )

    res = client.get("/admin/system/overview", headers=headers)
    assert res.status_code == 200

    deployment = res.json()["deployment"]
    assert deployment["status"] == "unknown"
    assert deployment["github_latest_commit"] is None
    assert deployment["github_error"] == "Timed out contacting GitHub."
    assert deployment["github_error_code"] == "timeout"


def test_admin_current_user_failures_today_reports_plain_english_summary(client, db, monkeypatch):
    admin = _register_user(client, role="admin")
    headers = _login_headers(client, admin["email"], admin["password"])

    failure_time = datetime.now(timezone.utc).replace(hour=12, minute=0, second=0, microsecond=0)
    db.add(OAuthAccount(
        user_id=admin["id"],
        provider="google",
        account_email="admin.failure@test.com",
        access_token="token-value",
        refresh_token="refresh-value",
        last_sync_failure=failure_time,
        last_error="Stored credential is encrypted but TOKEN_ENCRYPTION_KEY is not configured.",
        status="error",
    ))
    db.add(TVDiagLog(
        user_id=admin["id"],
        event="calendar_publish_result",
        details="status=error failed=1 reason=no_targets",
        ts_server=failure_time,
    ))
    db.commit()

    monkeypatch.setattr(settings, "token_encryption_key", None, raising=False)

    res = client.get("/admin/system/current-user-failures-today", headers=headers)
    assert res.status_code == 200

    payload = res.json()
    assert payload["user"]["email"] == admin["email"]
    assert payload["has_failures"] is True
    assert payload["counts"]["sync_failures_today"] == 1
    assert payload["counts"]["publish_failures_today"] == 1
    assert any("sync failure" in line.lower() for line in payload["summary_lines"])
    assert len(payload["sync_failure_accounts"]) == 1
    assert len(payload["publish_failures"]) == 1


def test_admin_current_user_failures_today_is_scoped_to_logged_in_admin(client, db):
    admin_one = _register_user(client, role="admin")
    admin_two = _register_user(client, role="admin")
    headers_two = _login_headers(client, admin_two["email"], admin_two["password"])

    db.add(OAuthAccount(
        user_id=admin_one["id"],
        provider="google",
        account_email="other-admin@test.com",
        access_token="token-value",
        refresh_token="refresh-value",
        last_sync_failure=datetime.now(timezone.utc),
        last_error="failure",
        status="error",
    ))
    db.commit()

    res = client.get("/admin/system/current-user-failures-today", headers=headers_two)
    assert res.status_code == 200

    payload = res.json()
    assert payload["user"]["email"] == admin_two["email"]
    assert payload["counts"]["sync_failures_today"] == 0
    assert payload["has_failures"] is False


def test_admin_apply_runtime_token_encryption_key_repairs_missing_key_for_running_app(client, db, monkeypatch):
    headers = _admin_headers(client)
    owner = _register_user(client, role="staff")
    known_key = Fernet.generate_key().decode()

    monkeypatch.setattr(settings, "token_encryption_key", known_key, raising=False)
    reset_cipher_cache()
    db.add(OAuthAccount(
        user_id=owner["id"],
        provider="google",
        account_email="repair@test.com",
        access_token="live-token",
        refresh_token="live-refresh",
    ))
    db.commit()

    monkeypatch.setattr(settings, "token_encryption_key", None, raising=False)
    monkeypatch.delenv("TOKEN_ENCRYPTION_KEY", raising=False)
    reset_cipher_cache()

    res = client.post(
        "/admin/system/token-encryption-key/runtime",
        headers=headers,
        json={"token_encryption_key": known_key},
    )
    assert res.status_code == 200
    payload = res.json()
    assert payload["resolved"] is True
    assert payload["security"]["token_encryption_key_configured"] is True
    assert payload["security"]["missing_key_with_encrypted_credentials"] is False
    assert payload["persists_after_restart"] is True
    assert load_persisted_token_encryption_key(db) == known_key


def test_admin_apply_runtime_token_encryption_key_persists_for_restart_bootstrap(client, db, monkeypatch):
    headers = _admin_headers(client)
    owner = _register_user(client, role="staff")
    known_key = Fernet.generate_key().decode()

    monkeypatch.setattr(settings, "token_encryption_key", known_key, raising=False)
    reset_cipher_cache()
    db.add(OAuthAccount(
        user_id=owner["id"],
        provider="google",
        account_email="persisted-bootstrap@test.com",
        access_token="live-token",
        refresh_token="live-refresh",
    ))
    db.commit()

    sealed = db.query(OAuthAccount).filter(OAuthAccount.account_email == "persisted-bootstrap@test.com").first().access_token_encrypted
    assert str(sealed).startswith("v1:")

    monkeypatch.setattr(settings, "token_encryption_key", None, raising=False)
    monkeypatch.delenv("TOKEN_ENCRYPTION_KEY", raising=False)
    reset_cipher_cache()

    res = client.post(
        "/admin/system/token-encryption-key/runtime",
        headers=headers,
        json={"token_encryption_key": known_key},
    )
    assert res.status_code == 200
    assert res.json()["persists_after_restart"] is True

    # Simulate restart-like in-process key loss; persisted key should restore decryptability.
    monkeypatch.setattr(settings, "token_encryption_key", None, raising=False)
    monkeypatch.delenv("TOKEN_ENCRYPTION_KEY", raising=False)
    reset_cipher_cache()

    persisted = load_persisted_token_encryption_key(db)
    assert persisted == known_key
    monkeypatch.setattr(settings, "token_encryption_key", persisted, raising=False)
    reset_cipher_cache()
    assert unseal(str(sealed)) == "live-token"


def test_admin_apply_runtime_token_encryption_key_rejects_wrong_key(client, db, monkeypatch):
    headers = _admin_headers(client)
    owner = _register_user(client, role="staff")
    known_key = Fernet.generate_key().decode()
    wrong_key = Fernet.generate_key().decode()

    monkeypatch.setattr(settings, "token_encryption_key", known_key, raising=False)
    reset_cipher_cache()
    db.add(OAuthAccount(
        user_id=owner["id"],
        provider="google",
        account_email="wrong-key@test.com",
        access_token="live-token",
        refresh_token="live-refresh",
    ))
    db.commit()

    monkeypatch.setattr(settings, "token_encryption_key", None, raising=False)
    monkeypatch.delenv("TOKEN_ENCRYPTION_KEY", raising=False)
    reset_cipher_cache()

    res = client.post(
        "/admin/system/token-encryption-key/runtime",
        headers=headers,
        json={"token_encryption_key": wrong_key},
    )
    assert res.status_code == 422
    assert "could not be decrypted" in res.json()["detail"].lower()


def test_admin_apply_runtime_token_encryption_key_requires_admin(client):
    staff_headers = _staff_headers(client)
    denied = client.post(
        "/admin/system/token-encryption-key/runtime",
        headers=staff_headers,
        json={"token_encryption_key": Fernet.generate_key().decode()},
    )
    assert denied.status_code == 403


def test_admin_current_user_failure_history_summarizes_range(client, db):
    admin = _register_user(client, role="admin")
    headers = _login_headers(client, admin["email"], admin["password"])
    failure_time = datetime(2026, 7, 20, 12, 0, tzinfo=timezone.utc)

    db.add(OAuthAccount(
        user_id=admin["id"],
        provider="google",
        account_email="history@test.com",
        access_token="token-value",
        refresh_token="refresh-value",
        last_sync_failure=failure_time,
        last_error="Provider timeout",
        status="error",
    ))
    db.add(TVDiagLog(
        user_id=admin["id"],
        event="calendar_publish_result",
        details="status=error failed=1 reason=no_targets",
        ts_server=failure_time,
    ))
    db.commit()

    res = client.get(
        "/admin/system/current-user-failure-history?start_date=2026-07-19&end_date=2026-07-21",
        headers=headers,
    )
    assert res.status_code == 200
    payload = res.json()
    assert payload["counts"]["sync_failures"] == 1
    assert payload["counts"]["publish_failure_rows"] == 1
    assert payload["counts"]["distinct_publish_failure_reasons"] == 1
    assert payload["publish_failure_reasons"][0]["reason"] == "no_targets"
    assert len(payload["recent_error_messages"]) == 1


def test_admin_current_user_failure_history_rejects_large_range(client):
    headers = _admin_headers(client)
    res = client.get(
        "/admin/system/current-user-failure-history?start_date=2026-01-01&end_date=2026-05-01",
        headers=headers,
    )
    assert res.status_code == 422


def test_admin_tv_stale_refresh_summary_reports_recent_fallbacks(client, db):
    admin = _register_user(client, role="admin")
    headers = _login_headers(client, admin["email"], admin["password"])
    other = _register_user(client, role="staff")
    now_utc = datetime.now(timezone.utc)

    db.add(TVDiagLog(
        user_id=admin["id"],
        event="stale_snapshot_used",
        details="backend_refresh_failure",
        device_id="device-admin-a",
        ts_server=now_utc,
        visibility="visible",
    ))
    db.add(TVDiagLog(
        user_id=other["id"],
        event="stale_snapshot_used",
        details="backend_refresh_failure_no_snapshot",
        device_id="device-staff-b",
        ts_server=now_utc,
        visibility="visible",
    ))
    db.add(TVDiagLog(
        user_id=other["id"],
        event="heartbeat",
        details="ignore",
        device_id="device-staff-b",
        ts_server=now_utc,
    ))
    db.commit()

    res = client.get("/admin/system/tv-stale-refresh-summary?hours=24&limit=50", headers=headers)
    assert res.status_code == 200

    payload = res.json()
    assert payload["counts"]["stale_snapshot_events"] == 2
    assert payload["counts"]["unique_devices"] == 2
    assert payload["counts"]["unique_users"] == 2
    reasons = {row["reason"]: row["count"] for row in payload["reason_counts"]}
    assert reasons.get("backend_refresh_failure") == 1
    assert reasons.get("backend_refresh_failure_no_snapshot") == 1
    assert len(payload["recent_rows"]) == 2


def test_admin_table_rows_requires_admin_role(client):
    staff_headers = _staff_headers(client)

    denied = client.get("/admin/system/table/users/rows", headers=staff_headers)
    assert denied.status_code == 403


def test_admin_table_rows_returns_select_all_payload(client):
    headers = _admin_headers(client)

    res = client.get("/admin/system/table/users/rows", headers=headers)
    assert res.status_code == 200

    payload = res.json()
    assert payload["table"] == "users"
    assert "columns" in payload
    assert "rows" in payload
    assert "count" in payload
    assert isinstance(payload["columns"], list)
    assert isinstance(payload["rows"], list)
    assert isinstance(payload["count"], int)


def test_admin_providers_crud_and_status_flow(client):
    headers = _admin_headers(client)

    owner = _register_user(client, role="staff")

    create_res = client.post("/admin/providers", headers=headers, json={
        "user_id": owner["id"],
        "provider": "google",
        "provider_name": "Google Family",
        "contact_email": "family.owner@test.com",
        "status": "active",
        "provider_id": "g-provider-001",
        "color": "#3366cc",
        "is_primary": True,
    })
    assert create_res.status_code == 200
    created = create_res.json()
    assert created["provider_name"] == "Google Family"
    assert created["contact_email"] == "family.owner@test.com"
    assert created["status"] == "active"
    assert created["metadata"]["provider"] == "google"
    assert created["metadata"]["user_id"] == owner["id"]
    assert created["metadata"]["owner_email"] == owner["email"]
    assert created["metadata"]["is_service_provider"] is True

    provider_id = created["id"]

    get_res = client.get(f"/admin/providers/{provider_id}", headers=headers)
    assert get_res.status_code == 200
    fetched = get_res.json()
    assert fetched["id"] == provider_id

    update_res = client.put(f"/admin/providers/{provider_id}", headers=headers, json={
        "provider_name": "Google Family Updated",
        "contact_email": "family.updated@test.com",
        "status": "inactive",
        "display_name": "Family Shared Calendar",
        "provider_id": "g-provider-001-upd",
        "color": "#228833",
        "is_primary": False,
    })
    assert update_res.status_code == 200
    updated = update_res.json()
    assert updated["provider_name"] == "Family Shared Calendar"
    assert updated["contact_email"] == "family.updated@test.com"
    assert updated["status"] == "inactive"
    assert updated["metadata"]["color"] == "#228833"

    status_res = client.post(f"/admin/providers/{provider_id}/status", headers=headers, json={
        "status": "active"
    })
    assert status_res.status_code == 200
    assert status_res.json()["status"] == "active"

    delete_res = client.delete(f"/admin/providers/{provider_id}", headers=headers)
    assert delete_res.status_code == 200
    assert delete_res.json() == {"deleted": True, "id": provider_id}

    missing_res = client.get(f"/admin/providers/{provider_id}", headers=headers)
    assert missing_res.status_code == 404


def test_admin_cleanup_classifies_legacy_placeholder_rows(client, db):
    headers = _admin_headers(client)
    owner = _register_user(client, role="staff")

    legacy = OAuthAccount(
        user_id=owner["id"],
        provider="google",
        account_email="legacy.placeholder@test.com",
        access_token="admin-placeholder-token",
        refresh_token=None,
        sync_enabled=True,
        is_primary=False,
        status="ok",
        is_service_provider=False,
    )
    db.add(legacy)
    db.commit()
    db.refresh(legacy)

    cleanup_res = client.post("/admin/providers/cleanup-placeholders", headers=headers)
    assert cleanup_res.status_code == 200
    assert cleanup_res.json()["updated"] >= 1

    db.refresh(legacy)
    assert legacy.is_service_provider is True


def test_accounts_endpoint_hides_service_provider_rows(client, db):
    staff = _register_user(client, role="staff")
    headers = _login_headers(client, staff["email"], staff["password"])

    real_account = OAuthAccount(
        user_id=staff["id"],
        provider="google",
        account_email="real.user@gmail.com",
        access_token="real-token",
        refresh_token="refresh-token",
        sync_enabled=True,
        is_primary=True,
        status="ok",
        is_service_provider=False,
    )
    service_placeholder = OAuthAccount(
        user_id=staff["id"],
        provider="google",
        account_email="test@example.com",
        access_token="admin-placeholder-token",
        refresh_token=None,
        sync_enabled=True,
        is_primary=False,
        status="ok",
        is_service_provider=True,
    )
    synthetic_retry_row = OAuthAccount(
        user_id=staff["id"],
        provider="google",
        account_email="dummy.google@example.com",
        access_token="__REAUTH_REQUIRED__",
        refresh_token=None,
        sync_enabled=True,
        is_primary=False,
        status="error",
        is_service_provider=False,
    )
    db.add(real_account)
    db.add(service_placeholder)
    db.add(synthetic_retry_row)
    db.commit()

    res = client.get("/accounts", headers=headers)
    assert res.status_code == 200
    payload = res.json()
    emails = {row["account_email"] for row in payload}

    assert "real.user@gmail.com" in emails
    assert "test@example.com" not in emails
    assert "dummy.google@example.com" not in emails


def test_admin_bulk_delete_users_with_related(client, db):
    headers = _admin_headers(client)
    staff = _register_user(client, role="staff")

    account = OAuthAccount(
        user_id=staff["id"],
        provider="google",
        account_email="bulk.user@gmail.com",
        access_token="token",
        refresh_token="refresh",
        sync_enabled=True,
        is_primary=True,
        status="ok",
        is_service_provider=False,
    )
    db.add(account)
    db.commit()
    db.refresh(account)

    event = Event(
        title="Bulk Event",
        description="x",
        start_time=datetime(2026, 6, 27, 12, 0, tzinfo=timezone.utc),
        end_time=datetime(2026, 6, 27, 13, 0, tzinfo=timezone.utc),
        owner_id=staff["id"],
        source="google",
        account_email="bulk.user@gmail.com",
    )
    db.add(event)
    db.commit()
    db.refresh(event)

    note = Note(content="n", event_id=event.id)
    task = Task(title="t", owner_id=staff["id"])
    sticky = DateStickyNote(owner_id=staff["id"], date="2026-06-27", sticky_notes=[])
    db.add_all([note, task, sticky])
    db.commit()

    res = client.post("/admin/users/bulk-delete", headers=headers, json={
        "ids": [staff["id"]],
        "delete_related": True,
    })
    assert res.status_code == 200
    payload = res.json()
    assert payload["deleted_users"] == 1

    users_after = client.get("/admin/users", headers=headers).json()
    assert all(row["id"] != staff["id"] for row in users_after)


def test_admin_bulk_delete_empty_only_skips_users_with_related_data(client, db):
    headers = _admin_headers(client)
    empty_user = _register_user(client, role="staff")
    protected_user = _register_user(client, role="staff")
    db.add(Task(title="Keep me", owner_id=protected_user["id"]))
    db.commit()

    res = client.post("/admin/users/bulk-delete", headers=headers, json={
        "ids": [empty_user["id"], protected_user["id"]],
        "delete_related": False,
        "only_if_no_related": True,
    })

    assert res.status_code == 200
    payload = res.json()
    assert payload["deleted_users"] == 1
    assert payload["skipped"] == [{
        "id": protected_user["id"],
        "reason": "has_related_data",
        "related": {
            "accounts": 0,
            "events": 0,
            "tasks": 1,
            "sticky_notes": 0,
            "date_sticky_notes": 0,
            "event_sticky_notes": 0,
            "notes": 0,
        },
    }]
    assert db.get(User, empty_user["id"]) is None
    assert db.get(User, protected_user["id"]) is not None


def test_admin_provider_related_and_bulk_delete(client, db):
    headers = _admin_headers(client)
    owner = _register_user(client, role="staff")

    provider_res = client.post("/admin/providers", headers=headers, json={
        "user_id": owner["id"],
        "provider": "google",
        "provider_name": "Bulk Provider",
        "contact_email": "bulk.provider@gmail.com",
        "status": "active",
        "is_primary": False,
    })
    assert provider_res.status_code == 200
    provider_id = provider_res.json()["id"]

    event = Event(
        title="Provider Event",
        description="x",
        start_time=datetime(2026, 6, 27, 12, 0, tzinfo=timezone.utc),
        end_time=datetime(2026, 6, 27, 13, 0, tzinfo=timezone.utc),
        owner_id=owner["id"],
        source="google",
        account_email="bulk.provider@gmail.com",
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    db.add(Note(content="n", event_id=event.id))
    db.commit()

    related = client.get(f"/admin/providers/{provider_id}/related-data", headers=headers)
    assert related.status_code == 200
    assert related.json()["related"]["events"] >= 1

    res = client.post("/admin/providers/bulk-delete", headers=headers, json={
        "ids": [provider_id],
        "delete_related": True,
    })
    assert res.status_code == 200
    assert res.json()["deleted_providers"] == 1


def test_admin_orphan_scan_and_delete(client, db):
    headers = _admin_headers(client)

    orphan_task = Task(title="orphan-task", owner_id=999999)
    db.add(orphan_task)
    db.commit()
    db.refresh(orphan_task)

    scan_res = client.get("/admin/maintenance/orphans", headers=headers)
    assert scan_res.status_code == 200
    assert "counts" in scan_res.json()
    assert scan_res.json()["counts"]["tasks"] >= 1

    del_res = client.post("/admin/maintenance/orphans/delete", headers=headers, json={})
    assert del_res.status_code == 200
    assert del_res.json()["deleted"]["tasks"] >= 1


def test_admin_user_related_data_includes_legacy_email_linked_events(client, db):
    headers = _admin_headers(client)
    target = _register_user(client, role="staff")

    target_user = db.query(User).filter(User.id == target["id"]).first()
    assert target_user is not None
    target_user.google_email = "legacy.linked@gmail.com"

    holder = _register_user(client, role="staff")
    linked_event = Event(
        title="Legacy Linked Event",
        description="legacy",
        start_time=datetime(2026, 6, 27, 12, 0, tzinfo=timezone.utc),
        end_time=datetime(2026, 6, 27, 13, 0, tzinfo=timezone.utc),
        owner_id=holder["id"],
        source="google",
        account_email="legacy.linked@gmail.com",
        sticky_notes=[{"content": "legacy sticky", "color": "#ffee88"}],
    )
    db.add(linked_event)
    db.commit()
    db.refresh(linked_event)

    db.add(Note(content="legacy note", event_id=linked_event.id))
    db.commit()

    related_res = client.get(f"/admin/users/{target['id']}/related-data", headers=headers)
    assert related_res.status_code == 200
    related = related_res.json()["related"]

    assert related["events"] >= 1
    assert related["notes"] >= 1
    assert related["sticky_notes"] >= 1

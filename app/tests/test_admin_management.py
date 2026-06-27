import uuid

from app.models import OAuthAccount


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


def test_admin_system_overview_payload(client):
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

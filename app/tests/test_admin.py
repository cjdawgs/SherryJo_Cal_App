# --------------------------------------------------
# IMPORTS
# --------------------------------------------------

from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


# --------------------------------------------------
# HELPER: CREATE ADMIN USER
# --------------------------------------------------

def create_admin_headers():
    """
    ✅ Creates and logs in an admin user
    ✅ Returns Authorization header
    """

    client.post("/auth/register", json={
        "username": "admin_user",
        "email": "admin_user@test.com",
        "password": "password",
        "role": "admin"
    })

    response = client.post("/auth/login", json={
        "email": "admin_user@test.com",
        "password": "password"
    })

    token = response.json()["access_token"]

    return {"Authorization": f"Bearer {token}"}


# --------------------------------------------------
# HELPER: CREATE STAFF USER
# --------------------------------------------------

def create_staff_headers():
    """
    ✅ Creates and logs in a normal (non-admin) user
    """

    client.post("/auth/register", json={
        "username": "staff_user",
        "email": "staff_user@test.com",
        "password": "password"
    })

    response = client.post("/auth/login", json={
        "email": "staff_user@test.com",
        "password": "password"
    })

    token = response.json()["access_token"]

    return {"Authorization": f"Bearer {token}"}


# --------------------------------------------------
# TEST: ADMIN CAN ACCESS /users ✅
# --------------------------------------------------

def test_admin_can_access_users():
    headers = create_admin_headers()

    response = client.get("/users/", headers=headers)

    assert response.status_code == 200
    assert isinstance(response.json(), list)


# --------------------------------------------------
# TEST: STAFF CANNOT ACCESS /users ✅
# --------------------------------------------------

def test_staff_cannot_access_users():
    headers = create_staff_headers()

    response = client.get("/users/", headers=headers)

    assert response.status_code == 403


# --------------------------------------------------
# TEST: NO TOKEN BLOCKED ✅
# --------------------------------------------------

def test_users_requires_authentication():
    response = client.get("/users/")

    assert response.status_code == 403 or response.status_code == 401
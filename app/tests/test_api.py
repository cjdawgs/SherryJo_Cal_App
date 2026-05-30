
from fastapi.testclient import TestClient
from app.main import app
import uuid

client = TestClient(app)


# --------------------------------------------------
# HEALTH CHECK
# --------------------------------------------------
def test_health():
    response = client.get("/health")
    assert response.status_code == 200


# --------------------------------------------------
# USER CREATION (BASIC)
# --------------------------------------------------
def test_register_user():
    unique_id = uuid.uuid4()

    response = client.post("/auth/register", json={
        "username": f"user_{unique_id}",   # ✅ FIX
        "email": f"user_{unique_id}@test.com",
        "password": "pass123"
    })

    assert response.status_code == 200




# --------------------------------------------------
# LOGIN USERS
# --------------------------------------------------
def test_login_user():
    # Register first
    client.post("/auth/register", json={
        "username": "user2",
        "email": "user2@test.com",
        "password": "pass123"
    })

    response = client.post("/auth/login", json={
        "email": "user2@test.com",
        "password": "pass123"
    })

    assert response.status_code == 200
    assert "access_token" in response.json()


# --------------------------------------------------
# GET USERS
# --------------------------------------------------
def test_get_users_requires_admin(auth_headers):
    response = client.get("/users/", headers=auth_headers)

    # ✅ non-admin should be forbidden
    assert response.status_code == 403




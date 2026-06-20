# --------------------------------------------------
# IMPORTS
# --------------------------------------------------

from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


# --------------------------------------------------
# TEST: HEALTH CHECK ✅
# --------------------------------------------------

def test_health():
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


# --------------------------------------------------
# TEST: REGISTER USER ✅
# --------------------------------------------------
import uuid

def test_register_user():
    unique_email = f"user_{uuid.uuid4()}@test.com"
    unique_username = f"user_{uuid.uuid4()}"

    response = client.post("/auth/register", json={
        "username": unique_username,   # ✅ FIXED
        "email": unique_email,
        "password": "password"
    })

    assert response.status_code == 200

# --------------------------------------------------
# TEST: LOGIN USER ✅
# --------------------------------------------------

def test_login_user():
    # ✅ Ensure user exists first
    client.post("/auth/register", json={
        "username": "loginuser",
        "email": "login@example.com",
        "password": "password"
    })

    # ✅ Login using EMAIL (matches your API)
    response = client.post("/auth/login", json={
        "email": "login@example.com",
        "password": "password"
    })

    assert response.status_code == 200

    data = response.json()

    # ✅ Validate token structure
    assert "access_token" in data
    assert data["token_type"] == "bearer"


# --------------------------------------------------
# TEST: INVALID LOGIN ✅
# --------------------------------------------------

def test_login_invalid_credentials():
    response = client.post("/auth/login", json={
        "email": "wrong@example.com",
        "password": "wrongpassword"
    })

    assert response.status_code == 401


# --------------------------------------------------
# TEST: REGISTER ADMIN USER ✅ (NEW)
# --------------------------------------------------
def test_register_admin_user():
    import uuid
    unique_email = f"admin_{uuid.uuid4()}@test.com"
    unique_username = f"admin_{uuid.uuid4()}"

    response = client.post("/auth/register", json={
        "username": unique_username,   # ✅ FIXED
        "email": unique_email,
        "password": "password",
        "role": "admin",
        "admin_setup_code": "mintmule99999"
    })

    assert response.status_code == 200   # ✅ FIX (was 20 typo)
    


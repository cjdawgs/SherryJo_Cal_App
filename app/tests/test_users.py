# --------------------------------------------------
# IMPORTS
# --------------------------------------------------

# --------------------------------------------------
# HELPER: CREATE ADMIN USER + TOKEN
# --------------------------------------------------
import uuid

def create_admin_headers(client):
    unique_email = f"admin_{uuid.uuid4()}@test.com"
    unique_username = f"admin_{uuid.uuid4()}"   # ✅ ADD THIS

    client.post("/auth/register", json={
        "username": unique_username,   # ✅ FIXED
        "email": unique_email,
        "password": "password",
        "role": "admin",
        "master_admin_code": "test-master-admin-code"
    })

    response = client.post("/auth/login", json={
        "email": unique_email,
        "password": "password"
    })

    token = response.json()["access_token"]

    return {"Authorization": f"Bearer {token}"}

# --------------------------------------------------
# HELPER: CREATE NORMAL USER
# --------------------------------------------------
import uuid
def create_user_headers(client):
    unique_email = f"user_{uuid.uuid4()}@test.com"
    unique_username = f"user_{uuid.uuid4()}"   # ✅ ADD THIS

    client.post("/auth/register", json={
        "username": unique_username,   # ✅ FIXED
        "email": unique_email,
        "password": "password"
    })

    response = client.post("/auth/login", json={
        "email": unique_email,
        "password": "password"
    })

    token = response.json()["access_token"]

    return {"Authorization": f"Bearer {token}"}


# --------------------------------------------------
# TEST: ADMIN CAN ACCESS USERS LIST ✅
# --------------------------------------------------

def test_get_users_admin_success(client):
    headers = create_admin_headers(client)

    response = client.get("/users/", headers=headers)

    assert response.status_code == 200
    assert isinstance(response.json(), list)


# --------------------------------------------------
# TEST: NON-ADMIN IS FORBIDDEN ✅
# --------------------------------------------------

def test_get_users_forbidden_for_staff(client):
    headers = create_user_headers(client)

    response = client.get("/users/", headers=headers)

    assert response.status_code == 403


# --------------------------------------------------
# TEST: GET CURRENT USER ✅
# --------------------------------------------------

def test_get_current_user(client):
    headers = create_user_headers(client)

    response = client.get("/users/me", headers=headers)

    assert response.status_code == 200
    data = response.json()

    assert "id" in data
    assert "email" in data
    assert data["role"] == "staff"

# --------------------------------------------------
# IMPORTS
# --------------------------------------------------

# --------------------------------------------------
# TEST: HEALTH CHECK ✅
# --------------------------------------------------

def test_health(client):
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_login_page_supports_username_or_email_recovery(client):
    response = client.get("/login")

    assert response.status_code == 200
    assert 'placeholder="Username or email"' in response.text
    assert 'id="loginRecovery"' in response.text
    assert "Try your registered username or your full email address" in response.text


# --------------------------------------------------
# TEST: REGISTER USER ✅
# --------------------------------------------------
import uuid

def test_register_user(client):
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

def test_login_user(client):
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


def test_login_user_by_username(client):
    client.post("/auth/register", json={
        "username": "username_login_user",
        "email": "username-login@example.com",
        "password": "password"
    })

    response = client.post("/auth/login", json={
        "email": "USERNAME_LOGIN_USER",
        "password": "password"
    })

    assert response.status_code == 200
    assert "access_token" in response.json()


# --------------------------------------------------
# TEST: INVALID LOGIN ✅
# --------------------------------------------------

def test_login_invalid_credentials(client):
    response = client.post("/auth/login", json={
        "email": "wrong@example.com",
        "password": "wrongpassword"
    })

    assert response.status_code == 401


# --------------------------------------------------
# TEST: REGISTER ADMIN USER ✅ (NEW)
# --------------------------------------------------
def test_register_admin_user(client):
    import uuid
    unique_email = f"admin_{uuid.uuid4()}@test.com"
    unique_username = f"admin_{uuid.uuid4()}"

    response = client.post("/auth/register", json={
        "username": unique_username,   # ✅ FIXED
        "email": unique_email,
        "password": "password",
        "role": "admin",
        "master_admin_code": "test-master-admin-code"
    })

    assert response.status_code == 200   # ✅ FIX (was 20 typo)
    

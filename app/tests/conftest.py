# app/tests/conftest.py

import os
import pytest
import uuid

from fastapi.testclient import TestClient

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

# ✅ Import your app + DB base
from app.main import app
from app.database import Base, get_db


# ==================================================
# ✅ TEST DATABASE CONFIG (IN-MEMORY, FAST)
# ==================================================

SQLALCHEMY_DATABASE_URL = "sqlite://"  # ✅ in-memory DB

# ✅ StaticPool is CRITICAL:
# - ensures ALL sessions share the SAME DB
# - prevents "no such table" errors
engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)

# ✅ Session factory
TestingSessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
)


# ==================================================
# ✅ CREATE TABLES ONCE (SESSION-SCOPED)
# ==================================================

@pytest.fixture(scope="session", autouse=True)
def setup_database():
    """
    Runs once for the entire test session.

    ✅ Creates tables in memory
    ✅ No Alembic needed → MUCH faster
    """
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


# ==================================================
# ✅ DB SESSION (TRANSACTION PER TEST)
# ==================================================

@pytest.fixture(scope="function")
def db():
    """
    Creates a clean DB transaction per test.

    ✅ Each test runs in a transaction
    ✅ Rolls back after test
    ✅ SUPER fast + isolated
    """

    connection = engine.connect()

    # ✅ BEGIN TRANSACTION
    transaction = connection.begin()

    session = TestingSessionLocal(bind=connection)

    try:
        yield session
    finally:
        session.close()

        # ✅ ROLLBACK everything
        if transaction.is_active:
            transaction.rollback()
        connection.close()


# ==================================================
# ✅ TEST CLIENT (DEPENDENCY OVERRIDE)
# ==================================================

@pytest.fixture(scope="function")
def client(db):
    """
    FastAPI TestClient with test DB injected.
    """

    def override_get_db():
        try:
            yield db
        finally:
            pass

    # ✅ Override dependency
    app.dependency_overrides[get_db] = override_get_db

    yield TestClient(app)

    # ✅ Cleanup
    app.dependency_overrides.clear()


# ==================================================
# ✅ AUTH HEADERS FIXTURE (JWT)
# ==================================================

def register_and_login(client, role="staff"):
    """Create a user with the given role and return (user_id, auth headers)."""

    unique_id = uuid.uuid4()

    register_data = {
        "username": f"user_{unique_id}",
        "email": f"user_{unique_id}@test.com",
        "password": "pass123",
        "role": role,
    }

    registered = client.post("/auth/register", json=register_data).json()

    response = client.post("/auth/login", json={
        "email": register_data["email"],
        "password": register_data["password"],
    })

    token = response.json()["access_token"]

    return registered["id"], {"Authorization": f"Bearer {token}"}


@pytest.fixture
def auth_headers(client):
    """
    Creates a fresh test user + returns JWT token.
    """

    _user_id, headers = register_and_login(client)
    return headers


@pytest.fixture
def user_a(client):
    """First staff user: (user_id, auth headers)."""
    return register_and_login(client)


@pytest.fixture
def user_b(client):
    """Second staff user, for cross-user access tests."""
    return register_and_login(client)


@pytest.fixture
def admin_headers(client):
    """Auth headers for an admin user."""
    _user_id, headers = register_and_login(client, role="admin")
    return headers
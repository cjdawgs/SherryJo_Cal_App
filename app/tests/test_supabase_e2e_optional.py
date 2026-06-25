import os
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.main import app
from app.database import get_db
import app.routers.calendar as calendar_router


@pytest.mark.skipif(
    os.getenv("RUN_SUPABASE_E2E") != "1",
    reason="Set RUN_SUPABASE_E2E=1 to run external Supabase E2E test",
)
def test_supabase_e2e_sticky_routes_and_sync_contract():
    db_url = os.getenv("SHERRYJO_E2E_DB_URL", "").strip()
    if not db_url:
        pytest.skip("Set SHERRYJO_E2E_DB_URL to run external Supabase E2E test")

    connect_args = {"sslmode": "require"} if db_url.startswith("postgresql") else {}
    engine = create_engine(db_url, pool_pre_ping=True, connect_args=connect_args)
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    def override_get_db():
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db

    old_sync_all = calendar_router.calendar_service.sync_all

    def fake_sync_all(_db, _user):
        return {
            "results": [],
            "account_sync_totals": [],
        }

    calendar_router.calendar_service.sync_all = fake_sync_all

    try:
        with TestClient(app) as client:
            unique = uuid.uuid4().hex[:8]
            email = f"supa_e2e_{unique}@example.com"
            username = f"supa_e2e_{unique}"

            reg = client.post(
                "/auth/register",
                json={"username": username, "email": email, "password": "pass123"},
            )
            assert reg.status_code in {200, 201}

            login = client.post(
                "/auth/login",
                json={"email": email, "password": "pass123"},
            )
            assert login.status_code == 200
            token = login.json().get("access_token")
            assert token

            headers = {"Authorization": f"Bearer {token}"}

            schema = client.get("/health/schema")
            assert schema.status_code == 200
            schema_data = schema.json()
            assert "missing_tables" in schema_data

            date_key = "2026-06-25"
            put_res = client.put(
                f"/calendar/date-sticky/{date_key}",
                headers=headers,
                json={"sticky_notes": [{"content": "Supabase E2E sticky", "color": "#F7E68A"}]},
            )
            assert put_res.status_code == 200

            list_res = client.get("/calendar/date-sticky", headers=headers)
            assert list_res.status_code == 200
            list_data = list_res.json()
            assert list_data.get("status") in {"ok", "error"}

            sync_res = client.post("/calendar/sync", headers=headers)
            assert sync_res.status_code == 200
            sync_data = sync_res.json()
            assert sync_data.get("status") in {"success", "error"}

            unified = client.get("/calendar/unified", headers=headers)
            assert unified.status_code == 200
            unified_data = unified.json()
            assert "events" in unified_data
            assert "account_status" in unified_data
            assert "account_event_totals" in unified_data

    finally:
        calendar_router.calendar_service.sync_all = old_sync_all
        app.dependency_overrides.clear()
        engine.dispose()

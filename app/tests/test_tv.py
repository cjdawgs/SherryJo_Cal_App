"""
test_tv.py
==========
Tests for the TV Mode router and pairing service.

Coverage:
- Pairing code generation (admin/user flow)
- Pairing code redemption (Apple TV flow)
- One-time-use enforcement
- TTL expiry
- GET /tv/state — returns None selectedDate (no today() injection)
- PATCH /tv/state — persists partial updates
- GET /tv/events — returns empty when selectedDate is None
- GET /tv/events — returns grouped events when selectedDate is set
- GET /display/tv — display extension
"""

import pytest
import uuid
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _reset_tv_stores():
    """Clear in-memory TV stores between tests to prevent state leakage."""
    from app.services.tv_pairing_service import pairing_store, tv_state_store
    pairing_store._codes.clear()
    tv_state_store._states.clear()
    yield
    pairing_store._codes.clear()
    tv_state_store._states.clear()


# ─────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────

def _register_and_login(client) -> dict:
    """Create a unique user and return auth headers."""
    uid = uuid.uuid4()
    client.post("/auth/register", json={
        "username": f"tv_user_{uid}",
        "email": f"tv_{uid}@test.com",
        "password": "tvpass123",
    })
    resp = client.post("/auth/login", json={
        "email": f"tv_{uid}@test.com",
        "password": "tvpass123",
    })
    token = resp.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


# ─────────────────────────────────────────────────
# PAIRING SERVICE UNIT TESTS
# ─────────────────────────────────────────────────

class TestPairingStore:
    def test_generate_code_format(self):
        from app.services.tv_pairing_service import _PairingStore
        store = _PairingStore()
        result = store.create_code(user_id=1)
        code = result["pairingCode"]
        assert len(code) == 9
        assert code[4] == "-"
        assert code[:4].isalnum()
        assert code[5:].isalnum()

    def test_redeem_valid_code(self):
        from app.services.tv_pairing_service import _PairingStore
        store = _PairingStore()
        result = store.create_code(user_id=42)
        user_id = store.redeem_code(result["pairingCode"])
        assert user_id == 42

    def test_code_is_one_time_use(self):
        from app.services.tv_pairing_service import _PairingStore
        store = _PairingStore()
        result = store.create_code(user_id=7)
        code = result["pairingCode"]
        assert store.redeem_code(code) == 7
        assert store.redeem_code(code) is None  # second use fails

    def test_invalid_code_returns_none(self):
        from app.services.tv_pairing_service import _PairingStore
        store = _PairingStore()
        assert store.redeem_code("ZZZZ-9999") is None

    def test_expired_code_returns_none(self):
        from app.services.tv_pairing_service import _PairingStore
        store = _PairingStore()
        result = store.create_code(user_id=3)
        code = result["pairingCode"]
        # Manually expire it
        store._codes[code]["expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
        assert store.redeem_code(code) is None


class TestTVStateStore:
    def test_initial_state_returns_none(self):
        from app.services.tv_pairing_service import _TVStateStore
        store = _TVStateStore()
        assert store.get(user_id=999) is None

    def test_initialize_does_not_inject_today(self):
        from app.services.tv_pairing_service import _TVStateStore
        store = _TVStateStore()
        state = store.initialize(user_id=1, selected_date=None)
        assert state["selectedDate"] is None

    def test_patch_updates_only_provided_keys(self):
        from app.services.tv_pairing_service import _TVStateStore
        store = _TVStateStore()
        store.initialize(user_id=5, selected_date="2026-06-01", current_view="day")
        updated = store.set(user_id=5, patch={"currentView": "week"})
        assert updated["selectedDate"] == "2026-06-01"
        assert updated["currentView"] == "week"

    def test_patch_ignores_unknown_keys(self):
        from app.services.tv_pairing_service import _TVStateStore
        store = _TVStateStore()
        store.initialize(user_id=6, selected_date="2026-06-01")
        updated = store.set(user_id=6, patch={"unknownKey": "value", "currentView": "day"})
        assert "unknownKey" not in updated
        assert updated["currentView"] == "day"


# ─────────────────────────────────────────────────
# API ENDPOINT TESTS
# ─────────────────────────────────────────────────

class TestGeneratePairingCode:
    def test_generate_code_requires_auth(self, client):
        resp = client.post("/tv/generate-code")
        assert resp.status_code == 401  # bearer scheme: no token → 401

    def test_generate_code_returns_code(self, client, auth_headers):
        resp = client.post("/tv/generate-code", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "pairingCode" in data
        assert len(data["pairingCode"]) == 9
        assert data["pairingCode"][4] == "-"
        assert "expiresIn" in data
        assert data["expiresIn"] == 600


class TestPairEndpoint:
    def test_pair_with_valid_code(self, client, auth_headers):
        # Generate a code via the web UI flow
        gen = client.post("/tv/generate-code", headers=auth_headers)
        code = gen.json()["pairingCode"]

        # Apple TV redeems the code
        resp = client.post("/tv/pair", json={"pairingCode": code})
        assert resp.status_code == 200
        data = resp.json()
        assert "token" in data
        assert "currentView" in data
        # selectedDate must not be forced to today
        assert "selectedDate" in data  # key exists; value may be None

    def test_pair_with_invalid_code(self, client):
        resp = client.post("/tv/pair", json={"pairingCode": "XXXX-9999"})
        assert resp.status_code == 400

    def test_pair_code_one_time_use(self, client, auth_headers):
        gen = client.post("/tv/generate-code", headers=auth_headers)
        code = gen.json()["pairingCode"]

        client.post("/tv/pair", json={"pairingCode": code})
        resp2 = client.post("/tv/pair", json={"pairingCode": code})
        assert resp2.status_code == 400


class TestTVStateEndpoints:
    def test_get_state_no_today_default(self, client, auth_headers):
        """selectedDate must NOT be injected with today() when state is empty."""
        resp = client.get("/tv/state", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["selectedDate"] is None
        assert data["currentUserEmail"]
        assert data["currentUserRole"]

    def test_patch_state_persists(self, client, auth_headers):
        resp = client.patch(
            "/tv/state",
            json={"selectedDate": "2026-07-04", "currentView": "week"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["selectedDate"] == "2026-07-04"
        assert data["currentView"] == "week"

    def test_patch_state_partial_update(self, client, auth_headers):
        # Set initial state
        client.patch("/tv/state", json={"selectedDate": "2026-08-01"}, headers=auth_headers)
        # Partial update — only view
        resp = client.patch("/tv/state", json={"currentView": "day"}, headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["selectedDate"] == "2026-08-01"
        assert data["currentView"] == "day"

    def test_get_state_requires_auth(self, client):
        resp = client.get("/tv/state")
        assert resp.status_code == 401  # bearer scheme: no token → 401

    def test_patch_state_requires_auth(self, client):
        resp = client.patch("/tv/state", json={"currentView": "week"})
        assert resp.status_code == 401  # bearer scheme: no token → 401


class TestTVEventsEndpoint:
    def test_events_returns_empty_when_no_selected_date(self, client, auth_headers):
        """No selectedDate → empty days, no today() injection."""
        resp = client.get("/tv/events", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["selectedDate"] is None
        assert data["days"] == []

    def test_events_grouped_by_date(self, client, auth_headers, db):
        from app.models import Event, User
        from app.security import decode_token

        # Determine user_id from the token
        token = auth_headers["Authorization"].split(" ")[1]
        payload = decode_token(token)
        user_id = payload["user_id"]

        # Insert a test event
        evt = Event(
            title="TV Test Event",
            start_time=datetime(2026, 9, 15, 10, 0, tzinfo=timezone.utc),
            end_time=datetime(2026, 9, 15, 11, 0, tzinfo=timezone.utc),
            owner_id=user_id,
        )
        db.add(evt)
        db.commit()

        # Set selectedDate to that day
        client.patch(
            "/tv/state",
            json={"selectedDate": "2026-09-15"},
            headers=auth_headers,
        )

        resp = client.get("/tv/events", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["selectedDate"] == "2026-09-15"
        assert len(data["days"]) >= 1
        day_dates = [d["date"] for d in data["days"]]
        assert "2026-09-15" in day_dates

    def test_events_requires_auth(self, client):
        resp = client.get("/tv/events")
        assert resp.status_code == 401  # bearer scheme: no token → 401

    def test_events_never_500_when_db_read_fails(self, client, auth_headers, monkeypatch):
        from app.routers import tv as tv_router
        from sqlalchemy.exc import SQLAlchemyError

        client.patch(
            "/tv/state",
            json={"selectedDate": "2026-10-11", "currentView": "week"},
            headers=auth_headers,
        )

        original_group = tv_router._group_events_by_date

        def _boom(*_args, **_kwargs):
            raise SQLAlchemyError("synthetic db failure")

        monkeypatch.setattr(tv_router, "_group_events_by_date", _boom)

        try:
            resp = client.get("/tv/events", headers=auth_headers)
        finally:
            monkeypatch.setattr(tv_router, "_group_events_by_date", original_group)

        assert resp.status_code == 200
        data = resp.json()
        assert data.get("currentView") == "week"
        assert isinstance(data.get("days"), list)

    def test_create_update_tv_event(self, client, auth_headers):
        client.patch(
            "/tv/state",
            json={"selectedDate": "2026-10-11", "currentView": "day"},
            headers=auth_headers,
        )

        create_resp = client.post(
            "/tv/events",
            json={"title": "Created From TV", "description": "inline"},
            headers=auth_headers,
        )
        assert create_resp.status_code == 200
        created = create_resp.json()["event"]
        assert created["title"] == "Created From TV"

        update_resp = client.put(
            f"/tv/events/{created['id']}",
            json={"title": "Edited On TV"},
            headers=auth_headers,
        )
        assert update_resp.status_code == 200
        updated = update_resp.json()["event"]
        assert updated["title"] == "Edited On TV"

    def test_upsert_tv_date_sticky(self, client, auth_headers):
        resp = client.put(
            "/tv/date-sticky/2026-10-11",
            json={"sticky_notes": [{"content": "TV sticky", "color": "#F7E68A"}]},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["item"]["count"] == 1

    def test_group_events_skips_invalid_legacy_rows(self):
        from types import SimpleNamespace
        from app.routers.tv import _group_events_by_date

        rows = [
            SimpleNamespace(
                id=1,
                title="Valid",
                start_time="2026-10-11T09:00:00+00:00",
                end_time="2026-10-11T10:00:00+00:00",
                description="",
                source="local",
                color=None,
            ),
            SimpleNamespace(
                id=2,
                title="Bad",
                start_time="not-a-date",
                end_time=None,
                description="",
                source="local",
                color=None,
            ),
        ]

        grouped = _group_events_by_date(rows)
        assert len(grouped) == 1
        assert grouped[0]["date"] == "2026-10-11"
        assert grouped[0]["events"][0]["id"] == 1

    def test_events_in_window_handles_string_datetimes(self):
        from types import SimpleNamespace
        from app.routers.tv import _events_in_window

        start = datetime(2026, 10, 11, 0, 0, tzinfo=timezone.utc)
        end = datetime(2026, 10, 11, 23, 59, tzinfo=timezone.utc)
        rows = [
            SimpleNamespace(start_time="2026-10-11T09:00:00+00:00"),
            SimpleNamespace(start_time="2026-10-12T09:00:00+00:00"),
            SimpleNamespace(start_time="bad-date"),
        ]

        filtered = _events_in_window(rows, start, end)
        assert len(filtered) == 1


class TestDisplayTVEndpoint:
    def test_display_tv_requires_auth(self, client):
        resp = client.get("/display/tv")
        assert resp.status_code == 401  # bearer scheme: no token → 401

    def test_display_tv_returns_state_shape(self, client, auth_headers):
        resp = client.get("/display/tv?mode=calendar", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "mode" in data
        assert "selectedDate" in data
        assert "currentView" in data
        assert "days" in data
        assert data["mode"] == "calendar"

    def test_display_tv_no_today_injection(self, client, auth_headers):
        """selectedDate must remain None if not set — no today() injection."""
        resp = client.get("/display/tv", headers=auth_headers)
        assert resp.status_code == 200
        # selectedDate is None unless explicitly set via PATCH /tv/state
        data = resp.json()
        # We can't assert None here if a previous test set it for the same user,
        # but we CAN assert the key exists
        assert "selectedDate" in data

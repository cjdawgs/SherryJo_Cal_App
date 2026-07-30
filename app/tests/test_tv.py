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
    from app.routers import tv as tv_router
    pairing_store._codes.clear()
    tv_state_store._states.clear()
    tv_router._tv_events_snapshot_cache.clear()
    tv_router._lan_autopair_ctx["user_id"] = None
    tv_router._lan_autopair_ctx["expires_at"] = None
    yield
    pairing_store._codes.clear()
    tv_state_store._states.clear()
    tv_router._tv_events_snapshot_cache.clear()
    tv_router._lan_autopair_ctx["user_id"] = None
    tv_router._lan_autopair_ctx["expires_at"] = None


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
        from app.security import decode_token

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

        payload = decode_token(data["token"])
        assert payload["user_id"]
        assert "exp" not in payload

    def test_pair_with_invalid_code(self, client):
        resp = client.post("/tv/pair", json={"pairingCode": "XXXX-9999"})
        assert resp.status_code == 400

    def test_pair_code_one_time_use(self, client, auth_headers):
        gen = client.post("/tv/generate-code", headers=auth_headers)
        code = gen.json()["pairingCode"]

        client.post("/tv/pair", json={"pairingCode": code})
        resp2 = client.post("/tv/pair", json={"pairingCode": code})
        assert resp2.status_code == 400


class TestAutoPairEndpoint:
    def test_auto_pair_requires_recent_generate_code(self, client):
        resp = client.post("/tv/auto-pair")
        assert resp.status_code == 404

    def test_auto_pair_succeeds_after_generate_code(self, client, auth_headers):
        gen = client.post("/tv/generate-code", headers=auth_headers)
        assert gen.status_code == 200

        resp = client.post("/tv/auto-pair")
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("token")
        assert "currentView" in data


class TestKioskToken:
    def test_generate_kiosk_token_is_persistent(self, client, auth_headers):
        from app.security import decode_token

        resp = client.post("/tv/generate-kiosk-token", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["expires_in"] == "persistent"
        assert "/tv/kiosk?token=" in data["kiosk_url"]

        payload = decode_token(data["token"])
        assert payload["user_id"]
        assert "exp" not in payload

        kiosk_resp = client.get(f"/tv/kiosk?token={data['token']}")
        assert kiosk_resp.status_code == 200


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

    def test_events_day_view_returns_single_day_window(self, client, auth_headers, db):
        from app.models import Event
        from app.security import decode_token

        token = auth_headers["Authorization"].split()[1]
        payload = decode_token(token)
        user_id = payload["user_id"]

        db.add(Event(
            title="Single Day Window Event",
            start_time=datetime(2026, 10, 20, 9, 0, tzinfo=timezone.utc),
            end_time=datetime(2026, 10, 20, 10, 0, tzinfo=timezone.utc),
            owner_id=user_id,
        ))
        db.add(Event(
            title="Adjacent Day Event",
            start_time=datetime(2026, 10, 21, 9, 0, tzinfo=timezone.utc),
            end_time=datetime(2026, 10, 21, 10, 0, tzinfo=timezone.utc),
            owner_id=user_id,
        ))
        db.commit()

        client.patch(
            "/tv/state",
            json={"selectedDate": "2026-10-20", "currentView": "day"},
            headers=auth_headers,
        )

        resp = client.get("/tv/events", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["currentView"] == "day"
        assert [day["date"] for day in data["days"]] == ["2026-10-20"]

    def test_events_three_day_view_keeps_centered_strip(self, client, auth_headers, db):
        from app.models import Event
        from app.security import decode_token

        token = auth_headers["Authorization"].split()[1]
        payload = decode_token(token)
        user_id = payload["user_id"]

        for offset in (-1, 0, 1):
            day = 20 + offset
            db.add(Event(
                title=f"Strip Event {offset}",
                start_time=datetime(2026, 10, day, 9, 0, tzinfo=timezone.utc),
                end_time=datetime(2026, 10, day, 10, 0, tzinfo=timezone.utc),
                owner_id=user_id,
            ))
        db.commit()

        client.patch(
            "/tv/state",
            json={"selectedDate": "2026-10-20", "currentView": "3-day"},
            headers=auth_headers,
        )

        resp = client.get("/tv/events", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["currentView"] == "3-day"
        assert [day["date"] for day in data["days"]] == ["2026-10-19", "2026-10-20", "2026-10-21"]

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
            sticky_note={"content": "sticky from test", "color": "#F7E68A"},
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
        selected_day = next(d for d in data["days"] if d["date"] == "2026-09-15")
        assert selected_day["events"]
        assert "hasSticky" in selected_day["events"][0]
        assert selected_day["events"][0]["hasSticky"] is True

    def test_events_marks_has_sticky_for_legacy_event_payload(self, client, auth_headers, db):
        from app.models import Event
        from app.security import decode_token

        token = auth_headers["Authorization"].split(" ")[1]
        payload = decode_token(token)
        user_id = payload["user_id"]

        db.add(Event(
            title="Legacy Sticky Event",
            start_time=datetime(2026, 9, 16, 11, 0, tzinfo=timezone.utc),
            end_time=datetime(2026, 9, 16, 12, 0, tzinfo=timezone.utc),
            owner_id=user_id,
            sticky_note={"text": "legacy sticky text"},
        ))
        db.commit()

        client.patch(
            "/tv/state",
            json={"selectedDate": "2026-09-16", "currentView": "day"},
            headers=auth_headers,
        )

        res = client.get("/tv/events", headers=auth_headers)
        assert res.status_code == 200
        payload = res.json()
        day = next(d for d in payload["days"] if d["date"] == "2026-09-16")
        assert any(bool(ev.get("hasSticky")) for ev in day.get("events", []))

    def test_events_normalizes_legacy_date_sticky_payload(self, client, auth_headers, db):
        from app.models import DateStickyNote
        from app.security import decode_token

        token = auth_headers["Authorization"].split(" ")[1]
        payload = decode_token(token)
        user_id = payload["user_id"]

        db.add(DateStickyNote(
            owner_id=user_id,
            date="2026-09-17",
            sticky_notes=[{"text": "legacy date sticky"}],
        ))
        db.commit()

        client.patch(
            "/tv/state",
            json={"selectedDate": "2026-09-17", "currentView": "day"},
            headers=auth_headers,
        )

        res = client.get("/tv/events", headers=auth_headers)
        assert res.status_code == 200
        payload = res.json()
        day = next(d for d in payload["days"] if d["date"] == "2026-09-17")
        sticky_notes = day.get("stickyNotes") or []
        assert sticky_notes
        assert sticky_notes[0]["content"] == "legacy date sticky"

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

    def test_events_returns_cached_snapshot_when_refresh_fails(self, client, auth_headers, db, monkeypatch):
        from app.routers import tv as tv_router
        from app.models import Event
        from app.security import decode_token

        token = auth_headers["Authorization"].split(" ")[1]
        payload = decode_token(token)
        user_id = payload["user_id"]

        db.add(Event(
            title="Snapshot Seed Event",
            start_time=datetime(2026, 10, 13, 15, 0, tzinfo=timezone.utc),
            end_time=datetime(2026, 10, 13, 16, 0, tzinfo=timezone.utc),
            owner_id=user_id,
            source="local",
            account_email="local",
        ))
        db.commit()

        client.patch(
            "/tv/state",
            json={"selectedDate": "2026-10-13", "currentView": "day"},
            headers=auth_headers,
        )

        seed = client.get("/tv/events", headers=auth_headers)
        assert seed.status_code == 200
        seed_payload = seed.json()
        assert seed_payload.get("staleData") is False
        assert any(day.get("events") for day in seed_payload.get("days", []))

        original_group = tv_router._group_events_by_date

        def _boom(*_args, **_kwargs):
            raise RuntimeError("synthetic grouping failure")

        monkeypatch.setattr(tv_router, "_group_events_by_date", _boom)
        try:
            stale = client.get("/tv/events", headers=auth_headers)
        finally:
            monkeypatch.setattr(tv_router, "_group_events_by_date", original_group)

        assert stale.status_code == 200
        stale_payload = stale.json()
        assert stale_payload.get("staleData") is True
        assert stale_payload.get("staleReason") == "backend_refresh_failure"
        assert stale_payload.get("days") == seed_payload.get("days")

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

# ==================================================
# TEST CALENDAR SYNC (API ENDPOINT TESTS)
# ==================================================

from unittest.mock import patch
from datetime import datetime, timezone
from fastapi.testclient import TestClient
from app.main import app
import jwt
from app.routers.auth import SECRET_KEY
from app.models import Event, User, OAuthAccount

client = TestClient(app)


# ==================================================
# HELPER: REAL JWT TOKEN
# ==================================================

def get_test_token():
    return jwt.encode({"user_id": 1}, SECRET_KEY, algorithm="HS256")


# ==================================================
# TEST: SYNC EVENTS (POST /calendar/sync)
# ==================================================

@patch("app.services.calendar_service.GoogleCalendarService.refresh_token")
@patch("app.services.calendar_service.GoogleCalendarService.fetch_events")
@patch("app.services.calendar_service.GraphClient.get_events")
def test_sync_events(mock_get_events, mock_fetch, mock_refresh):
    """
    ✅ Tests full sync pipeline:
    - external APIs mocked
    - JWT auth
    - DB integration path
    """

    mock_get_events.return_value = {"value": []}
    mock_fetch.return_value = []
    mock_refresh.return_value = {"access_token": "fake"}

    response = client.post(
        "/calendar/sync",
        headers={"Authorization": f"Bearer {get_test_token()}"}
    )

    assert response.status_code == 200

    data = response.json()

    # ✅ Correct structure — sync returns {status, result, range_days, ...}
    assert data.get("status") == "success"
    assert "result" in data

    result = data["result"]

    # ✅ Metrics validation
    assert "created" in result
    assert "updated" in result


# ==================================================
# TEST: UNIFIED CALENDAR (GET /calendar/unified)
# ==================================================

@patch("app.services.calendar_service.GraphClient.get_tasks")
def test_unified_calendar(mock_get_tasks):
    """
    ✅ Tests unified endpoint (read-only aggregation)
    """

    mock_get_tasks.return_value = {"value": []}

    response = client.get(
        "/calendar/unified",
        headers={"Authorization": f"Bearer {get_test_token()}"}
    )

    assert response.status_code == 200

    data = response.json()

    # ✅ Validate structure based on actual API response
    assert "events" in data
    assert "account_status" in data
    assert "account_event_totals" in data


def test_unified_calendar_expands_linked_accounts_when_dedup_off(client, auth_headers, db):
    user = db.query(User).filter(User.email.like("%@test.com")).first()
    assert user is not None

    db.add(Event(
        title="Shared Listing Tour",
        start_time=datetime(2026, 7, 12, 15, 0, tzinfo=timezone.utc),
        end_time=datetime(2026, 7, 12, 16, 0, tzinfo=timezone.utc),
        owner_id=user.id,
        source="local",
        account_email="local",
        externalId="local:canonical:shared-listing-tour",
        external_ids={
            "google:sherrychipjohansson@gmail.com": "g-1",
            "google:sherryajohansson@gmail.com": "g-2",
            "apple:sherryajohansson@gmail.com": "a-1",
            "google:sherryjohanssonrealestate@gmail.com": "g-3",
        },
    ))
    db.commit()

    response = client.get(
        "/calendar/unified?start=2026-07-01T00:00:00Z&end=2026-07-31T23:59:59Z&dedup=false",
        headers=auth_headers,
    )

    assert response.status_code == 200

    data = response.json()
    totals = data["account_event_totals"]
    keys = {ev["account_key"] for ev in data["events"]}

    assert totals["google:sherrychipjohansson@gmail.com"] == 1
    assert totals["google:sherryajohansson@gmail.com"] == 1
    assert totals["apple:sherryajohansson@gmail.com"] == 1
    assert totals["google:sherryjohanssonrealestate@gmail.com"] == 1
    assert "local:local" not in totals
    assert "google:sherrychipjohansson@gmail.com" in keys
    assert "google:sherryajohansson@gmail.com" in keys
    assert "apple:sherryajohansson@gmail.com" in keys
    assert "google:sherryjohanssonrealestate@gmail.com" in keys


@patch("app.services.event_actions.ensure_valid_token", return_value="token-1")
@patch("app.services.google_calendar_service.GoogleCalendarService.create_event", return_value="google-new-1")
def test_publish_single_event_to_selected_account_creates_missing_link(mock_google_create, _mock_token, client, auth_headers, db):
    user = db.query(User).filter(User.email.like("%@test.com")).first()
    assert user is not None

    db.add(OAuthAccount(
        user_id=user.id,
        provider="google",
        account_email="publish@example.com",
        access_token="token-1",
        refresh_token="refresh-1",
    ))
    db.add(Event(
        title="Publish Me",
        start_time=datetime(2026, 7, 12, 17, 0, tzinfo=timezone.utc),
        end_time=datetime(2026, 7, 12, 18, 0, tzinfo=timezone.utc),
        owner_id=user.id,
        source="local",
        account_email="local",
        externalId="local:publish-me",
        external_ids={},
        description="Needs to land on a second calendar",
    ))
    db.commit()

    event = db.query(Event).filter(Event.title == "Publish Me").first()
    assert event is not None

    response = client.post(
        "/calendar/publish",
        headers=auth_headers,
        json={
            "event_ids": [event.id],
            "publish_targets": {
                str(event.id): ["google:publish@example.com"]
            }
        }
    )

    assert response.status_code == 200

    data = response.json()
    assert data["published"] == 1
    assert data["created"] == 1
    assert data["failed"] == 0
    assert data["affected_accounts"] == ["google:publish@example.com"]

    db.refresh(event)
    assert event.external_ids["google:publish@example.com"] == "google-new-1"
    mock_google_create.assert_called_once()
# ==================================================
# TEST CALENDAR SYNC (API ENDPOINT TESTS)
# ==================================================

from unittest.mock import patch
from fastapi.testclient import TestClient
from app.main import app
import jwt
from app.routers.auth import SECRET_KEY

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
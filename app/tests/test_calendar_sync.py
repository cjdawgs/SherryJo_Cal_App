# ==================================================
# TEST CALENDAR SYNC (API ENDPOINT TESTS)
# ==================================================

from unittest.mock import patch
from datetime import datetime, timedelta, timezone
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


def test_dedup_materialize_promotes_provider_event_to_local(client, auth_headers, db):
    user = db.query(User).filter(User.email.like("%@test.com")).first()
    assert user is not None

    event = Event(
        title="Provider Editable Canonical",
        start_time=datetime(2026, 7, 13, 15, 0, tzinfo=timezone.utc),
        end_time=datetime(2026, 7, 13, 16, 0, tzinfo=timezone.utc),
        owner_id=user.id,
        source="google",
        account_email="editable@example.com",
        externalId="google:editable@example.com:g-editable-1",
        external_ids={"google:editable@example.com": "g-editable-1"},
    )
    db.add(event)
    db.commit()
    db.refresh(event)

    response = client.post("/calendar/dedup-materialize", headers=auth_headers)
    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert response.json()["changed"] >= 1

    db.refresh(event)
    assert event.source == "local"
    assert event.account_email == "local"
    assert event.external_ids == {"google:editable@example.com": "g-editable-1"}

    dedup_on = client.get(
        "/calendar/unified?start=2026-07-01T00:00:00Z&end=2026-07-31T23:59:59Z&dedup=true",
        headers=auth_headers,
    )
    assert dedup_on.status_code == 200
    keys_on = {ev["account_key"] for ev in dedup_on.json()["events"] if ev["title"] == "Provider Editable Canonical"}
    assert keys_on == {"local:local"}

    dedup_off = client.get(
        "/calendar/unified?start=2026-07-01T00:00:00Z&end=2026-07-31T23:59:59Z&dedup=false",
        headers=auth_headers,
    )
    assert dedup_off.status_code == 200
    keys_off = {ev["account_key"] for ev in dedup_off.json()["events"] if ev["title"] == "Provider Editable Canonical"}
    assert keys_off == {"google:editable@example.com"}


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


@patch("app.services.google_calendar_service.GoogleCalendarService.update_event")
def test_publish_prefers_healthy_duplicate_oauth_account(mock_google_update, client, auth_headers, db):
    user = db.query(User).filter(User.email.like("%@test.com")).first()
    assert user is not None

    db.add(OAuthAccount(
        user_id=user.id,
        provider="google",
        account_email="duplicate@example.com",
        access_token="__REAUTH_REQUIRED__",
        refresh_token=None,
        status="error",
        last_error="No valid token available",
    ))
    db.add(OAuthAccount(
        user_id=user.id,
        provider="google",
        account_email="duplicate@example.com",
        access_token="token-good",
        refresh_token="refresh-good",
        status="ok",
        last_sync_success=datetime(2026, 7, 19, 12, 0, tzinfo=timezone.utc),
    ))
    db.add(Event(
        title="Publish Duplicate Token Event",
        start_time=datetime(2026, 7, 12, 17, 0, tzinfo=timezone.utc),
        end_time=datetime(2026, 7, 12, 18, 0, tzinfo=timezone.utc),
        owner_id=user.id,
        source="local",
        account_email="local",
        externalId="google:duplicate@example.com:g-duplicate-1",
        external_ids={"google:duplicate@example.com": "g-duplicate-1"},
    ))
    db.commit()

    event = db.query(Event).filter(Event.title == "Publish Duplicate Token Event").first()
    assert event is not None

    def valid_token_for_healthy_row(_db, account):
        return "token-good" if account.access_token == "token-good" else None

    with patch("app.services.event_actions.ensure_valid_token", side_effect=valid_token_for_healthy_row):
        response = client.post(
            "/calendar/publish",
            headers=auth_headers,
            json={"event_ids": [event.id]},
        )

    assert response.status_code == 200

    data = response.json()
    assert data["published"] == 1
    assert data["failed"] == 0
    mock_google_update.assert_called_once()
    assert mock_google_update.call_args.kwargs["token"] == "token-good"


@patch("app.services.event_actions.ensure_valid_token")
@patch("app.services.graph_client.GraphClient.update_event")
def test_publish_does_not_check_or_update_reauth_required_account(
    mock_ms_update, mock_ensure_token, client, auth_headers, db
):
    user = db.query(User).filter(User.email.like("%@test.com")).first()
    db.add(OAuthAccount(
        user_id=user.id,
        provider="microsoft",
        account_email="disconnected@example.com",
        access_token="__REAUTH_REQUIRED__",
        status="error",
        sync_enabled=True,
    ))
    db.add(Event(
        title="Disconnected Publish Target",
        start_time=datetime(2026, 7, 12, 17, 0, tzinfo=timezone.utc),
        end_time=datetime(2026, 7, 12, 18, 0, tzinfo=timezone.utc),
        owner_id=user.id,
        source="local",
        account_email="local",
        externalId="microsoft:disconnected@example.com:ms-1",
        external_ids={"microsoft:disconnected@example.com": "ms-1"},
    ))
    db.commit()

    event = db.query(Event).filter(Event.title == "Disconnected Publish Target").first()
    response = client.post(
        "/calendar/publish",
        headers=auth_headers,
        json={"event_ids": [event.id]},
    )

    assert response.status_code == 200
    assert response.json()["published"] == 0
    assert response.json()["failed"] == 1
    mock_ensure_token.assert_not_called()
    mock_ms_update.assert_not_called()


@patch("app.services.calendar_service.requests.get")
def test_microsoft_access_denied_marks_account_reauth_required(
    mock_get, client, auth_headers, db
):
    token = auth_headers["Authorization"].split(" ", 1)[1]
    user_id = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])["user_id"]
    user = db.query(User).filter(User.id == user_id).first()
    account = OAuthAccount(
        user_id=user.id,
        provider="microsoft",
        account_email="denied@contoso.test",
        access_token="current-access-token",
        refresh_token="refresh-token",
        token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        status="ok",
        sync_enabled=True,
    )
    db.add(account)
    db.commit()

    mock_get.return_value.status_code = 403
    mock_get.return_value.json.return_value = {
        "error": {
            "code": "ErrorAccessDenied",
            "message": "Access is denied.",
        }
    }
    mock_get.return_value.text = "ErrorAccessDenied"

    response = client.post("/calendar/sync", headers=auth_headers)

    assert response.status_code == 200
    db.refresh(account)
    assert account.access_token == "__REAUTH_REQUIRED__"
    assert account.status == "error"
    assert "ErrorAccessDenied" in account.last_error


@patch("app.services.event_actions.ensure_valid_token", return_value="token-1")
@patch("app.services.google_calendar_service.GoogleCalendarService.create_event", return_value="google-new-after-missing")
@patch("app.services.google_calendar_service.GoogleCalendarService.update_event", return_value=404)
def test_publish_recreates_missing_provider_event(mock_google_update, mock_google_create, _mock_token, client, auth_headers, db):
    user = db.query(User).filter(User.email.like("%@test.com")).first()
    assert user is not None

    db.add(OAuthAccount(
        user_id=user.id,
        provider="google",
        account_email="missing@example.com",
        access_token="token-1",
        refresh_token="refresh-1",
        status="ok",
    ))
    db.add(Event(
        title="Publish Missing Provider Event",
        start_time=datetime(2026, 7, 12, 17, 0, tzinfo=timezone.utc),
        end_time=datetime(2026, 7, 12, 18, 0, tzinfo=timezone.utc),
        owner_id=user.id,
        source="local",
        account_email="local",
        externalId="google:missing@example.com:stale-google-id",
        external_ids={"google:missing@example.com": "stale-google-id"},
    ))
    db.commit()

    event = db.query(Event).filter(Event.title == "Publish Missing Provider Event").first()
    assert event is not None

    response = client.post(
        "/calendar/publish",
        headers=auth_headers,
        json={"event_ids": [event.id]},
    )

    assert response.status_code == 200

    data = response.json()
    assert data["published"] == 1
    assert data["created"] == 1
    assert data["failed"] == 0
    assert data["affected_accounts"] == ["google:missing@example.com"]

    db.refresh(event)
    assert event.external_ids["google:missing@example.com"] == "google-new-after-missing"
    mock_google_update.assert_called_once()
    mock_google_create.assert_called_once()


@patch("app.services.event_actions.ensure_valid_token", return_value="token-1")
@patch("app.services.google_calendar_service.GoogleCalendarService.delete_event")
def test_publish_deleted_event_targets_provider_accounts(mock_google_delete, _mock_token, client, auth_headers, db):
    user = db.query(User).filter(User.email.like("%@test.com")).first()
    assert user is not None

    db.add(OAuthAccount(
        user_id=user.id,
        provider="google",
        account_email="delete@example.com",
        access_token="token-1",
        refresh_token="refresh-1",
    ))
    db.commit()

    response = client.post(
        "/calendar/publish",
        headers=auth_headers,
        json={
            "event_ids": [],
            "deleted_events": [
                {
                    "title": "Delete Me",
                    "external_ids": {"google:delete@example.com": "g-delete-1"},
                }
            ],
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["deleted"] == 1
    assert data["failed"] == 0
    assert data["affected_accounts"] == ["google:delete@example.com"]
    mock_google_delete.assert_called_once_with(
        token="token-1",
        event_id="g-delete-1",
        account_email="delete@example.com",
    )
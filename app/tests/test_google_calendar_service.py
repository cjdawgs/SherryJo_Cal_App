from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from app.config import settings
from app.services.google_calendar_service import GoogleCalendarService


@pytest.fixture
def service():
    return GoogleCalendarService()


def make_response(status_code=200, json_data=None, text=""):
    response = MagicMock()
    response.status_code = status_code
    response.json.return_value = json_data if json_data is not None else {}
    response.text = text
    return response


# ==================================================
# AUTH URL
# ==================================================

def test_build_auth_url_contains_required_oauth_params(service, monkeypatch):
    monkeypatch.setattr(settings, "GOOGLE_CLIENT_ID", "client-123")

    url = service.build_auth_url("state-abc")

    assert url.startswith(GoogleCalendarService.AUTH_URL)
    assert "client_id=client-123" in url
    assert "access_type=offline" in url
    assert "prompt=consent" in url
    assert "state=state-abc" in url
    assert "&amp;" not in url


# ==================================================
# TOKEN EXCHANGE / REFRESH
# ==================================================

@patch("app.services.google_calendar_service.requests.post")
def test_exchange_code_returns_tokens(mock_post, service):
    mock_post.return_value = make_response(
        json_data={"access_token": "at", "refresh_token": "rt", "expires_in": 3600}
    )

    data = service.exchange_code("auth-code", redirect_uri="https://app/callback")

    assert data["refresh_token"] == "rt"
    payload = mock_post.call_args[1]["data"]
    assert payload["code"] == "auth-code"
    assert payload["redirect_uri"] == "https://app/callback"
    assert payload["grant_type"] == "authorization_code"


@patch("app.services.google_calendar_service.requests.post")
def test_exchange_code_without_refresh_token_still_returns_data(mock_post, service):
    mock_post.return_value = make_response(json_data={"access_token": "at"})

    assert service.exchange_code("auth-code") == {"access_token": "at"}


@patch("app.services.google_calendar_service.requests.post")
def test_exchange_code_raises_on_error(mock_post, service):
    mock_post.return_value = make_response(status_code=400, text="invalid_grant")

    with pytest.raises(Exception, match="token exchange failed"):
        service.exchange_code("bad-code")


@patch("app.services.google_calendar_service.requests.post")
def test_refresh_token_returns_new_access_token(mock_post, service):
    mock_post.return_value = make_response(json_data={"access_token": "new"})

    assert service.refresh_token("rt") == {"access_token": "new"}
    assert mock_post.call_args[1]["data"]["grant_type"] == "refresh_token"


@patch("app.services.google_calendar_service.requests.post")
def test_refresh_token_returns_empty_dict_on_failure(mock_post, service):
    mock_post.return_value = make_response(status_code=400, text="expired")

    assert service.refresh_token("rt") == {}


# ==================================================
# FETCH EVENTS
# ==================================================

@patch("app.services.google_calendar_service.requests.get")
def test_fetch_events_skips_system_calendars(mock_get, service):
    calendar_list = make_response(json_data={"items": [
        {"id": "work@example.com"},
        {"id": "en.usa#holiday@group.v.calendar.google.com"},
        {"id": "team@group.v.calendar.google.com"},
        {"id": ""},
    ]})
    events = make_response(json_data={"items": [{"id": "e1"}]})
    mock_get.side_effect = [calendar_list, events, events, events]

    result = service.fetch_events("token", account_email="me@example.com")

    requested = [call.args[0] for call in mock_get.call_args_list[1:]]
    assert all("group.v.calendar.google.com" not in url for url in requested)
    assert len(requested) == 3  # primary + account email + work calendar
    assert len(result) == 3


@patch("app.services.google_calendar_service.requests.get")
def test_fetch_events_forces_utc_on_naive_dates(mock_get, service):
    mock_get.side_effect = [
        make_response(json_data={"items": []}),
        make_response(json_data={"items": []}),
    ]

    service.fetch_events(
        "token",
        start_date=datetime(2026, 1, 1, 0, 0),
        end_date=datetime(2026, 1, 31, 0, 0),
    )

    params = mock_get.call_args_list[1][1]["params"]
    assert params["timeMin"] == datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat()
    assert params["timeMax"] == datetime(2026, 1, 31, tzinfo=timezone.utc).isoformat()


@patch("app.services.google_calendar_service.requests.get")
def test_fetch_events_falls_back_when_calendar_list_fails(mock_get, service):
    mock_get.side_effect = [
        make_response(status_code=500, text="server error"),
        make_response(json_data={"items": [{"id": "e1"}]}),
    ]

    assert service.fetch_events("token") == [{"id": "e1"}]


@patch("app.services.google_calendar_service.requests.get")
def test_fetch_events_ignores_failed_calendar_requests(mock_get, service):
    mock_get.side_effect = [
        make_response(json_data={"items": []}),
        make_response(status_code=403, text="forbidden"),
    ]

    assert service.fetch_events("token") == []


@patch("app.services.google_calendar_service.requests.get")
def test_get_events_delegates_to_fetch_events(mock_get, service):
    mock_get.side_effect = [
        make_response(json_data={"items": []}),
        make_response(json_data={"items": [{"id": "e1"}]}),
    ]

    assert service.get_events("token") == [{"id": "e1"}]


# ==================================================
# FETCH EVENTS V2 (INCREMENTAL)
# ==================================================

@patch("app.services.google_calendar_service.requests.get")
def test_fetch_events_v2_full_fetch_splits_cancelled_events(mock_get, service):
    mock_get.side_effect = [
        make_response(json_data={"items": []}),
        make_response(json_data={
            "items": [
                {"id": "e1", "status": "confirmed"},
                {"id": "e2", "status": "cancelled"},
                {"status": "cancelled"},
            ],
            "nextSyncToken": "token-1",
        }),
    ]

    result = service.fetch_events_v2("token")

    assert result["events"] == [{"id": "e1", "status": "confirmed"}]
    assert result["cancelled_ids"] == ["e2"]
    assert result["next_tokens"] == {"primary": "token-1"}
    assert result["used_incremental"] is False


@patch("app.services.google_calendar_service.requests.get")
def test_fetch_events_v2_uses_sync_token_when_available(mock_get, service):
    mock_get.side_effect = [
        make_response(json_data={"items": []}),
        make_response(json_data={"items": [{"id": "e1"}], "nextSyncToken": "token-2"}),
    ]

    result = service.fetch_events_v2("token", sync_token_state={"primary": "token-1"})

    assert result["used_incremental"] is True
    assert mock_get.call_args_list[1][1]["params"]["syncToken"] == "token-1"
    assert result["next_tokens"] == {"primary": "token-2"}


@patch("app.services.google_calendar_service.requests.get")
def test_fetch_events_v2_retries_full_fetch_when_sync_token_expired(mock_get, service):
    mock_get.side_effect = [
        make_response(json_data={"items": []}),
        make_response(status_code=410),
        make_response(json_data={"items": [{"id": "e1"}], "nextSyncToken": "fresh"}),
    ]

    result = service.fetch_events_v2(
        "token",
        start_date=datetime(2026, 1, 1, tzinfo=timezone.utc),
        end_date=datetime(2026, 2, 1, tzinfo=timezone.utc),
        sync_token_state={"primary": "stale"},
    )

    retry_params = mock_get.call_args_list[2][1]["params"]
    assert "syncToken" not in retry_params
    assert retry_params["timeMin"] == "2026-01-01T00:00:00+00:00"
    assert result["events"] == [{"id": "e1"}]
    assert result["next_tokens"] == {"primary": "fresh"}


@patch("app.services.google_calendar_service.requests.get")
def test_fetch_events_v2_follows_pagination(mock_get, service):
    mock_get.side_effect = [
        make_response(json_data={"items": []}),
        make_response(json_data={"items": [{"id": "e1"}], "nextPageToken": "page-2"}),
        make_response(json_data={"items": [{"id": "e2"}], "nextSyncToken": "final"}),
    ]

    result = service.fetch_events_v2("token")

    assert [event["id"] for event in result["events"]] == ["e1", "e2"]
    assert mock_get.call_args_list[2][1]["params"]["pageToken"] == "page-2"


@patch("app.services.google_calendar_service.requests.get")
def test_fetch_events_v2_survives_calendar_list_exception(mock_get, service):
    mock_get.side_effect = [
        Exception("network down"),
        make_response(json_data={"items": [{"id": "e1"}]}),
    ]

    assert service.fetch_events_v2("token")["events"] == [{"id": "e1"}]


@patch("app.services.google_calendar_service.requests.get")
def test_fetch_events_v2_skips_failed_calendar(mock_get, service):
    mock_get.side_effect = [
        make_response(json_data={"items": []}),
        make_response(status_code=500, text="boom"),
    ]

    result = service.fetch_events_v2("token")

    assert result["events"] == []
    assert result["next_tokens"] == {}


# ==================================================
# WRITE OPERATIONS
# ==================================================

@patch("app.services.google_calendar_service.requests.patch")
def test_update_event_maps_fields(mock_patch, service):
    mock_patch.return_value = make_response(status_code=200)

    status = service.update_event(
        "token",
        "event-1",
        {
            "title": "New title",
            "start_time": datetime(2026, 1, 1, 9, tzinfo=timezone.utc),
            "end_time": datetime(2026, 1, 1, 10, tzinfo=timezone.utc),
        },
        account_email="me@example.com",
    )

    assert status == 200
    payload = mock_patch.call_args[1]["json"]
    assert payload["summary"] == "New title"
    assert payload["start"]["dateTime"] == "2026-01-01T09:00:00+00:00"
    assert "me@example.com" in mock_patch.call_args[0][0]


@patch("app.services.google_calendar_service.requests.patch")
def test_update_event_reports_failure_status(mock_patch, service):
    mock_patch.return_value = make_response(status_code=404, text="not found")

    assert service.update_event("token", "event-1", {}) == 404


@patch("app.services.google_calendar_service.requests.post")
def test_create_event_returns_new_id(mock_post, service):
    mock_post.return_value = make_response(status_code=201, json_data={"id": "created-1"})

    event_id = service.create_event("token", {
        "title": "Dentist",
        "description": "Cleaning",
        "start_time": datetime(2026, 1, 1, 9, tzinfo=timezone.utc),
        "end_time": datetime(2026, 1, 1, 10, tzinfo=timezone.utc),
    })

    assert event_id == "created-1"
    payload = mock_post.call_args[1]["json"]
    assert payload["summary"] == "Dentist"
    assert payload["description"] == "Cleaning"


@patch("app.services.google_calendar_service.requests.post")
def test_create_event_defaults_title(mock_post, service):
    mock_post.return_value = make_response(status_code=200, json_data={"id": "created-2"})

    service.create_event("token", {})

    assert mock_post.call_args[1]["json"] == {"summary": "Untitled Event"}


@patch("app.services.google_calendar_service.requests.post")
def test_create_event_returns_none_on_failure(mock_post, service):
    mock_post.return_value = make_response(status_code=400, text="bad request")

    assert service.create_event("token", {"title": "x"}) is None


@patch("app.services.google_calendar_service.requests.post")
def test_create_event_returns_none_on_unparsable_body(mock_post, service):
    response = make_response(status_code=200)
    response.json.side_effect = ValueError("not json")
    mock_post.return_value = response

    assert service.create_event("token", {"title": "x"}) is None


@patch("app.services.google_calendar_service.requests.delete")
def test_delete_event_targets_account_calendar(mock_delete, service):
    mock_delete.return_value = make_response(status_code=204)

    service.delete_event("token", "event-1", account_email="me@example.com")

    url = mock_delete.call_args[0][0]
    assert url.endswith("/calendars/me@example.com/events/event-1")


@patch("app.services.google_calendar_service.requests.delete")
def test_delete_event_tolerates_failure(mock_delete, service):
    mock_delete.return_value = make_response(status_code=404, text="missing")

    assert service.delete_event("token", "event-1") is None


# ==================================================
# USER INFO
# ==================================================

@patch("app.services.google_calendar_service.requests.get")
def test_get_user_info_returns_profile(mock_get, service):
    mock_get.return_value = make_response(json_data={"email": "me@example.com"})

    assert service.get_user_info("token")["email"] == "me@example.com"


@patch("app.services.google_calendar_service.requests.get")
def test_get_user_info_raises_on_failure(mock_get, service):
    mock_get.return_value = make_response(status_code=401, text="unauthorized")

    with pytest.raises(Exception, match="Failed to fetch user info"):
        service.get_user_info("token")

from datetime import datetime, timezone
from unittest.mock import patch, MagicMock

from app.services.graph_client import GRAPH_BASE_URL, GraphClient


# ✅ Create reusable fake user (THIS IS KEY)
class FakeUser:
    ms_access_token = "fake_token"
    ms_refresh_token = "refresh"
    ms_token_expires = None


class TokenlessUser:
    ms_access_token = None


def make_response(status_code=200, json_data=None, text=""):
    response = MagicMock()
    response.status_code = status_code
    response.json.return_value = json_data if json_data is not None else {}
    response.text = text
    return response


# ==================================================
# TEST GET EVENTS
# ==================================================

@patch("app.services.graph_client.requests.get")
def test_get_events(mock_get):

    # ✅ Mock API response
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"value": []}
    mock_get.return_value = mock_response

    client = GraphClient()

    result = client.get_events(db=None, user=FakeUser())

    assert "value" in result


# ==================================================
# TEST GET TASKS
# ==================================================

@patch("app.services.graph_client.requests.get")
def test_get_tasks(mock_get):

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"value": []}
    mock_get.return_value = mock_response

    client = GraphClient()

    result = client.get_tasks(db=None, user=FakeUser())

    assert "value" in result

# ==================================================
# TEST CALENDAR VIEW WINDOW + PAGINATION
# ==================================================

@patch("app.services.graph_client.requests.get")
def test_get_events_uses_supplied_window(mock_get):
    mock_get.return_value = make_response(json_data={"value": []})

    GraphClient().get_events(
        user=FakeUser(),
        start=datetime(2026, 1, 1, tzinfo=timezone.utc),
        end=datetime(2026, 2, 1, tzinfo=timezone.utc),
    )

    url, kwargs = mock_get.call_args[0][0], mock_get.call_args[1]
    assert url == f"{GRAPH_BASE_URL}/me/calendarView"
    assert kwargs["params"] == {
        "startDateTime": "2026-01-01T00:00:00+00:00",
        "endDateTime": "2026-02-01T00:00:00+00:00",
    }


@patch("app.services.graph_client.requests.get")
def test_get_events_defaults_to_safe_window(mock_get):
    mock_get.return_value = make_response(json_data={"value": []})

    GraphClient().get_events_with_token("token")

    params = mock_get.call_args[1]["params"]
    assert params["startDateTime"] < params["endDateTime"]


@patch("app.services.graph_client.requests.get")
def test_get_events_follows_next_link(mock_get):
    mock_get.side_effect = [
        make_response(json_data={
            "value": [{"id": "e1"}],
            "@odata.nextLink": "https://graph.microsoft.com/page2",
        }),
        make_response(json_data={"value": [{"id": "e2"}]}),
    ]

    result = GraphClient().get_events_with_token("token")

    assert [event["id"] for event in result["value"]] == ["e1", "e2"]
    assert mock_get.call_args_list[1][0][0] == "https://graph.microsoft.com/page2"
    assert mock_get.call_args_list[1][1]["params"] is None


@patch("app.services.graph_client.requests.get")
def test_get_events_stops_on_error(mock_get):
    mock_get.return_value = make_response(status_code=401, text="unauthorized")

    assert GraphClient().get_events_with_token("token") == {"value": []}


def test_get_events_without_token_skips_request():
    assert GraphClient().get_events(user=TokenlessUser()) == {"value": []}


# ==================================================
# TEST TASKS
# ==================================================

def test_get_tasks_without_token_skips_request():
    assert GraphClient().get_tasks(user=None) == {"value": []}


@patch("app.services.graph_client.requests.get")
def test_get_tasks_returns_empty_on_error(mock_get):
    mock_get.return_value = make_response(status_code=500, text="boom")

    assert GraphClient().get_tasks(user=FakeUser()) == {"value": []}


@patch("app.services.graph_client.requests.get")
def test_get_tasks_adds_missing_value_key(mock_get):
    mock_get.return_value = make_response(json_data={"@odata.context": "ctx"})

    assert GraphClient().get_tasks(user=FakeUser())["value"] == []


# ==================================================
# TEST WRITE OPERATIONS
# ==================================================

@patch("app.services.graph_client.requests.patch")
def test_update_event_maps_outlook_fields(mock_patch):
    mock_patch.return_value = make_response(status_code=200)

    status = GraphClient().update_event("token", "event-1", {
        "title": "Renamed",
        "start_time": datetime(2026, 1, 1, 9, tzinfo=timezone.utc),
        "end_time": datetime(2026, 1, 1, 10, tzinfo=timezone.utc),
    })

    assert status == 200
    payload = mock_patch.call_args[1]["json"]
    assert payload["subject"] == "Renamed"
    assert payload["start"] == {"dateTime": "2026-01-01T09:00:00+00:00", "timeZone": "UTC"}
    assert payload["end"]["timeZone"] == "UTC"


@patch("app.services.graph_client.requests.patch")
def test_update_event_returns_failure_status(mock_patch):
    mock_patch.return_value = make_response(status_code=403, text="forbidden")

    assert GraphClient().update_event("token", "event-1", {}) == 403


@patch("app.services.graph_client.requests.post")
def test_create_event_returns_new_id(mock_post):
    mock_post.return_value = make_response(status_code=201, json_data={"id": "created-1"})

    event_id = GraphClient().create_event("token", {
        "title": "Dentist",
        "description": "Cleaning",
        "start_time": datetime(2026, 1, 1, 9, tzinfo=timezone.utc),
        "end_time": datetime(2026, 1, 1, 10, tzinfo=timezone.utc),
    })

    assert event_id == "created-1"
    payload = mock_post.call_args[1]["json"]
    assert payload["subject"] == "Dentist"
    assert payload["body"] == {"contentType": "HTML", "content": "Cleaning"}


@patch("app.services.graph_client.requests.post")
def test_create_event_defaults_title(mock_post):
    mock_post.return_value = make_response(json_data={"id": "created-2"})

    GraphClient().create_event("token", {})

    assert mock_post.call_args[1]["json"] == {"subject": "Untitled Event"}


@patch("app.services.graph_client.requests.post")
def test_create_event_returns_none_on_failure(mock_post):
    mock_post.return_value = make_response(status_code=400, text="bad request")

    assert GraphClient().create_event("token", {"title": "x"}) is None


@patch("app.services.graph_client.requests.post")
def test_create_event_returns_none_on_unparsable_body(mock_post):
    response = make_response()
    response.json.side_effect = ValueError("not json")
    mock_post.return_value = response

    assert GraphClient().create_event("token", {"title": "x"}) is None


@patch("app.services.graph_client.requests.delete")
def test_delete_event_targets_event_url(mock_delete):
    mock_delete.return_value = make_response(status_code=204)

    GraphClient().delete_event("token", "event-1")

    assert mock_delete.call_args[0][0] == f"{GRAPH_BASE_URL}/me/events/event-1"


@patch("app.services.graph_client.requests.delete")
def test_delete_event_tolerates_failure(mock_delete):
    mock_delete.return_value = make_response(status_code=404, text="missing")

    assert GraphClient().delete_event("token", "event-1") is None

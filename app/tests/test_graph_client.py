from unittest.mock import patch, MagicMock
from app.services.graph_client import GraphClient


# ✅ Create reusable fake user (THIS IS KEY)
class FakeUser:
    ms_access_token = "fake_token"
    ms_refresh_token = "refresh"
    ms_token_expires = None


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
import pytest
from fastapi.testclient import TestClient
from app.main import app
from unittest.mock import patch
from app.routers.auth import SECRET_KEY
from app.utils.oauth_state import encode_oauth_state

client = TestClient(app)



def test_login_redirect():
    """
    Ensure /ms/login redirects to Microsoft login URL
    """
    response = client.get("/ms/login", follow_redirects=False)

    assert response.status_code in (302, 307)
    assert "login.microsoftonline.com" in response.headers["location"]


def test_callback_missing_code(auth_headers):
    """
    Callback without code should fail
    """

    response = client.get(
        "/ms/callback",
        headers=auth_headers
    )

    assert response.status_code == 422

    data = response.json()
    assert "code" in str(data).lower()


@patch("app.routers.oauth.requests.post")
def test_callback_success(mock_post, auth_headers):
    """
    Simulate successful token exchange
    """

    mock_post.return_value.status_code = 200
    mock_post.return_value.json.return_value = {
        "access_token": "fake_access",
        "refresh_token": "fake_refresh",
        "expires_in": 3600,
    }

    response = client.get(
        "/ms/callback?code=testcode",
        headers=auth_headers
    )

    assert response.status_code == 200

    data = response.json()

    # ✅ FIXED ASSERTION
    assert data["message"] == "Microsoft connected"


@patch("app.routers.oauth.requests.post")
def test_stateful_callback_missing_token_returns_to_accounts(mock_post):
    mock_post.return_value.status_code = 400
    mock_post.return_value.json.return_value = {"error": "invalid_grant"}
    state = encode_oauth_state(1, "disconnected@example.com", SECRET_KEY)

    response = client.get(
        "/ms/callback",
        params={"code": "bad-code", "state": state},
        follow_redirects=False,
    )

    assert response.status_code in (302, 307)
    assert response.headers["location"].startswith("/accounts/ui?")
    assert "error=microsoft_token_missing" in response.headers["location"]
    assert "token=" in response.headers["location"]
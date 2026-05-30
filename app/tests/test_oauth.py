import pytest
from fastapi.testclient import TestClient
from app.main import app
from unittest.mock import patch

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
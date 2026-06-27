import pytest
import jwt
from fastapi.testclient import TestClient

from app.main import app
from app.routers.google_auth import SECRET_KEY


client = TestClient(app)


# --------------------------------------------------
# TEST: Login Redirect
# --------------------------------------------------
def test_google_login_redirect(mocker):
    """
    Ensure /auth/google/login returns redirect URL
    """

    # ✅ Mock JWT decode so it doesn't fail
    mocker.patch(
        "app.routers.google_auth.jwt.decode",
        return_value={"user_id": 1}
    )

    # ✅ Mock Google service
    mock_service = mocker.patch(
        "app.services.google_calendar_service.GoogleCalendarService.build_auth_url",
        return_value="https://mock.google/auth"
    )

    response = client.get(
        "/auth/google/login",
        params={"token": "fake.jwt.token"},  # ✅ looks like JWT
        follow_redirects=False
    )

    assert response.status_code == 307
    assert "https://mock.google/auth" in response.headers["location"]

    mock_service.assert_called_once()

# --------------------------------------------------
# TEST: Callback Success
# --------------------------------------------------
def test_google_callback_success(mocker):
    """
    Ensure callback returns access token
    """

    # ✅ Mock exchange
    mock_exchange = mocker.patch(
        "app.services.google_calendar_service.GoogleCalendarService.exchange_code",
        return_value={
            "access_token": "test_token_123",
            "refresh_token": "refresh_123",
            "expires_in": 3600
        }
    )

    # ✅ Mock user info
    mocker.patch(
        "app.services.google_calendar_service.GoogleCalendarService.get_user_info",
        return_value={"email": "test@example.com"}
    )

    # ✅ Mock DB
    class FakeUser:
        id = 1
        google_access_token = None
        google_refresh_token = None
        google_email = None

    fake_query = mocker.Mock()
    fake_query.first.return_value = FakeUser()

    fake_db = mocker.Mock()
    fake_db.query.return_value = fake_query

    mocker.patch(
        "app.routers.google_auth.get_db",
        return_value=fake_db
    )

    # ✅ ✅ ✅ THIS IS THE CRITICAL FIX
    response = client.get(
        "/auth/google/callback",
        params={
            "code": "testcode",
            "state": "1"
        },
        follow_redirects=False   # ✅ ✅ ✅ REQUIRED
    )

    # ✅ Now we correctly validate redirect
    assert response.status_code == 307
    assert "/calendar-ui" in response.headers["location"]

    mock_exchange.assert_called_once()
    
# --------------------------------------------------
# TEST: Callback Failure
# --------------------------------------------------
def test_google_callback_failure(mocker):
    """
    Ensure Google callback failures do not produce 500 responses.
    """

    mocker.patch(
        "app.services.google_calendar_service.GoogleCalendarService.exchange_code",
        side_effect=Exception("OAuth failed")
    )

    response = client.get(
        "/auth/google/callback",
        params={
            "code": "badcode",
            "state": "1"
        },
        follow_redirects=False
    )

    assert response.status_code == 307
    assert "/accounts/ui" in response.headers["location"]
    assert "google_oauth_failed" in response.headers["location"]


def test_google_callback_reconnect_fallback_when_userinfo_fails(mocker):
    """
    Reconnect should still complete when userinfo endpoint fails,
    by using reconnect email from state.
    """
    expected_email = "sherrychipjohansson@gmail.com"
    state = jwt.encode(
        {"user_id": 1, "reconnect": expected_email},
        SECRET_KEY,
        algorithm="HS256",
    )

    mocker.patch(
        "app.services.google_calendar_service.GoogleCalendarService.exchange_code",
        return_value={
            "access_token": "test_token_123",
            "refresh_token": "refresh_123",
            "expires_in": 3600,
        },
    )
    mocker.patch(
        "app.services.google_calendar_service.GoogleCalendarService.get_user_info",
        side_effect=Exception("userinfo unavailable"),
    )

    save_mock = mocker.patch(
        "app.services.multi_account_oauth_service.MultiAccountOAuthService.add_oauth_account",
        return_value=None,
    )

    response = client.get(
        "/auth/google/callback",
        params={"code": "goodcode", "state": state},
        follow_redirects=False,
    )

    assert response.status_code == 307
    assert "/accounts/ui" in response.headers["location"]
    assert "connected=google" in response.headers["location"]
    assert "account=sherrychipjohansson%40gmail.com" in response.headers["location"]

    save_mock.assert_called_once()
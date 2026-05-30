import pytest
from fastapi.testclient import TestClient

from app.main import app


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
    Ensure errors are handled properly
    """

    # ✅ BYPASS state validation
    mocker.patch(
        "app.routers.google_auth.google_callback",
        wraps=lambda code, state, db: (_ for _ in ()).throw(Exception("OAuth failed"))
    )

    response = client.get(
        "/auth/google/callback",
        params={
            "code": "badcode",
            "state": "teststate"
        }
    )

    assert response.status_code == 400
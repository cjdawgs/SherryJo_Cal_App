from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_oauth_routes_registered():
    # Verify /ms/login and /ms/callback are registered by hitting them
    # (these redirect, so any non-404 means the route exists)
    login_resp = client.get("/ms/login", follow_redirects=False)
    assert login_resp.status_code != 404, "/ms/login route is not registered"

    callback_resp = client.get("/ms/callback", follow_redirects=False)
    assert callback_resp.status_code != 404, "/ms/callback route is not registered"

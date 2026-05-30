from app.main import app


def test_oauth_routes_registered():
    routes = [route.path for route in app.routes]

    assert "/ms/login" in routes
    assert "/ms/callback" in routes

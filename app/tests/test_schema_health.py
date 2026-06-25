import app.routers.calendar as calendar_router
from app import main


def test_health_includes_schema_status(client):
    res = client.get("/health")
    assert res.status_code == 200

    data = res.json()
    assert data["status"] == "ok"
    assert "schema_status" in data
    assert data["schema_status"] in {"ok", "warning", "error"}


def test_schema_health_endpoint_returns_expected_shape(client):
    res = client.get("/health/schema")
    assert res.status_code == 200

    data = res.json()
    assert data["status"] in {"ok", "warning", "error"}
    assert isinstance(data.get("required_tables"), list)
    assert isinstance(data.get("missing_tables"), list)
    assert "checked_at" in data


def test_evaluate_schema_health_warns_on_missing_tables(monkeypatch):
    class FakeInspector:
        def get_table_names(self):
            return ["users", "events", "oauth_accounts", "tasks", "notes"]

    monkeypatch.setattr(main, "inspect", lambda _engine: FakeInspector())

    data = main.evaluate_schema_health()

    assert data["status"] == "warning"
    assert "date_sticky_notes" in data["missing_tables"]


def test_date_sticky_list_route_graceful_when_model_query_fails(client, auth_headers, monkeypatch):
    monkeypatch.setattr(calendar_router, "DateStickyNote", object)

    res = client.get("/calendar/date-sticky", headers=auth_headers)
    assert res.status_code == 200

    data = res.json()
    assert data["status"] == "ok"
    assert data["items"] == []


def test_sync_route_returns_json_error_on_internal_failure(client, auth_headers, monkeypatch):
    def _boom(_db, _user):
        raise RuntimeError("forced sync failure")

    monkeypatch.setattr(calendar_router.calendar_service, "sync_all", _boom)

    res = client.post("/calendar/sync", headers=auth_headers)
    assert res.status_code == 200

    data = res.json()
    assert data["status"] == "error"
    assert "forced sync failure" in data.get("message", "")

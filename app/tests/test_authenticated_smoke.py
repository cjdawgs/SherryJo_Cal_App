import asyncio
import json
from pathlib import Path
import subprocess
import sys

import pytest
import yaml

from deployment import authenticated_smoke
from deployment import render_synthetic


ROOT = Path(__file__).resolve().parents[2]


def _response(status, payload=None):
    body = b"" if payload is None else json.dumps(payload).encode("utf-8")
    return authenticated_smoke.HttpResult(status=status, body=body)


def test_remote_targets_require_explicit_https_opt_in():
    with pytest.raises(ValueError, match="--allow-remote"):
        authenticated_smoke._validate_target("https://edge.example.com", False)
    with pytest.raises(ValueError, match="HTTPS"):
        authenticated_smoke._validate_target("http://edge.example.com", True)

    assert authenticated_smoke._validate_target("http://127.0.0.1:8000/", False) == "http://127.0.0.1:8000"


def test_login_obtains_fresh_token_without_reporting_credentials(monkeypatch):
    calls = []

    def fake_request(origin, token, method, path, **kwargs):
        calls.append((origin, token, method, path, kwargs))
        return _response(200, {"access_token": "fresh-one-hour-token"})

    monkeypatch.setattr(authenticated_smoke, "_request", fake_request)

    token = authenticated_smoke._login(
        "https://render.example.com",
        "smoke@example.com",
        "secret-password",
    )

    assert token == "fresh-one-hour-token"
    assert calls == [
        (
            "https://render.example.com",
            "",
            "POST",
            "/auth/login",
            {"payload": {"email": "smoke@example.com", "password": "secret-password"}},
        )
    ]


def test_websocket_ticket_failure_names_target(monkeypatch):
    monkeypatch.setattr(
        authenticated_smoke,
        "_request",
        lambda *_args, **_kwargs: _response(404, {"detail": "Not Found"}),
    )

    with pytest.raises(
        authenticated_smoke.SmokeFailure,
        match=r"WebSocket ticket \(https://render\.example\.com\) returned HTTP 404",
    ):
        asyncio.run(
            authenticated_smoke._websocket_echo(
                "https://render.example.com",
                "temporary-token",
                "smoke-message",
            )
        )


def test_operational_reads_require_running_scheduler(monkeypatch):
    def fake_request(_origin, _token, _method, path, **_kwargs):
        if path in {"/tasks/", "/accounts"}:
            return _response(200, [])
        if path == "/accounts/sync-status":
            return _response(200, {"scheduler": {"running": False}})
        raise AssertionError(path)

    monkeypatch.setattr(authenticated_smoke, "_request", fake_request)

    with pytest.raises(authenticated_smoke.SmokeFailure, match="scheduler is not running"):
        authenticated_smoke._verify_operational_reads(
            "https://render.example.com",
            "temporary-token",
            "render",
        )


def test_authenticated_smoke_cleans_up_and_never_reports_secrets(monkeypatch):
    token = "secret-smoke-token"
    ticket = "secret-one-time-ticket"
    event_id = 41
    title = "[SMOKE] fixed-run"
    updated_title = f"{title} updated"
    note_id = "smoke-note-id"
    note_content = "[SMOKE] note fixed-run"
    requests = []
    deleted = False

    def fake_request(origin, supplied_token, method, path, **kwargs):
        nonlocal deleted
        if path.startswith("/static/"):
            assert supplied_token == ""
        else:
            assert supplied_token == token
        requests.append((origin, method, path))
        if method == "POST" and path == "/calendar/event":
            return _response(200, {"event": {"id": event_id, "title": title}})
        if method == "POST" and path == "/notes/":
            assert kwargs["payload"]["event_id"] == event_id
            assert kwargs["payload"]["content"] == note_content
            return _response(200, {"id": note_id, "content": note_content})
        if method == "GET" and path == "/events/":
            current_title = title if origin.endswith("edge.example.com") else updated_title
            return _response(200, [{"id": str(event_id), "title": current_title}])
        if method == "GET" and path.startswith("/notes/?date="):
            return _response(200, [] if deleted else [{"id": note_id, "content": note_content}])
        if method == "GET" and path in {"/tasks/", "/accounts"}:
            return _response(200, [])
        if method == "GET" and path == "/accounts/sync-status":
            return _response(200, {"scheduler": {"running": True}, "accounts": []})
        if method == "GET" and path == "/tv/version":
            return _response(200, {"appVersion": "test-version"})
        if method == "GET" and path == "/tv/state":
            return _response(200, {"selectedDate": None, "currentView": "day"})
        if method == "GET" and path == "/static/calendar.js":
            return authenticated_smoke.HttpResult(200, b"window.selectedDate" + (b" " * 100))
        if method == "PUT":
            return _response(200, {"event": {"id": event_id, "title": updated_title}})
        if path == "/calendar/import-events":
            return _response(422, {"detail": "Unsupported file type"})
        if path == "/ws/ticket":
            return _response(200, {"ticket": ticket})
        if method == "DELETE":
            deleted = True
            return _response(200, {"deleted": event_id})
        raise AssertionError((origin, method, path))

    async def fake_websocket_echo(origin, supplied_token, message):
        assert supplied_token == token
        assert message == "fixed-run"
        requests.append((origin, "WEBSOCKET", "/ws"))

    monkeypatch.setattr(authenticated_smoke, "_request", fake_request)
    monkeypatch.setattr(authenticated_smoke, "_websocket_echo", fake_websocket_echo)

    report = asyncio.run(
        authenticated_smoke.run_authenticated_smoke(
            "https://render.example.com",
            "https://edge.example.com",
            token,
            run_id="fixed-run",
        )
    )

    assert report["passed"] is True
    assert report["cleanup"] == {"attempted": True, "passed": True}
    assert "render_note_create" in report["checks"]
    assert "cloudflare_note_read" in report["checks"]
    assert "render_scheduler_running" in report["checks"]
    assert "cloudflare_calendar_asset" in report["checks"]
    assert "note_cleanup_verified" in report["checks"]
    assert ("https://edge.example.com", "DELETE", f"/calendar/event/{event_id}") in requests
    serialized = json.dumps(report)
    assert token not in serialized
    assert ticket not in serialized


def test_authenticated_smoke_fails_when_note_cleanup_leaves_residue(monkeypatch):
    event_id = 51
    note_id = "leftover-note"

    def fake_request(origin, _token, method, path, **_kwargs):
        if method == "POST" and path == "/calendar/event":
            return _response(200, {"event": {"id": event_id}})
        if method == "GET" and path == "/events/":
            title = "[SMOKE] residue-run" if origin.endswith("edge.example.com") else "[SMOKE] residue-run updated"
            return _response(200, [{"id": event_id, "title": title}])
        if method == "PUT":
            return _response(200, {"event": {"id": event_id, "title": "[SMOKE] residue-run updated"}})
        if method == "POST" and path == "/notes/":
            return _response(200, {"id": note_id, "content": "[SMOKE] note residue-run"})
        if method == "GET" and path.startswith("/notes/?date="):
            return _response(200, [{"id": note_id, "content": "[SMOKE] note residue-run"}])
        if path in {"/tasks/", "/accounts"}:
            return _response(200, [])
        if path == "/accounts/sync-status":
            return _response(200, {"scheduler": {"running": True}})
        if path == "/tv/version":
            return _response(200, {"appVersion": "test"})
        if path == "/tv/state":
            return _response(200, {"selectedDate": None, "currentView": "day"})
        if path == "/static/calendar.js":
            return authenticated_smoke.HttpResult(200, b"window.selectedDate" + (b" " * 100))
        if path == "/calendar/import-events":
            return _response(422, {})
        if method == "DELETE":
            return _response(200, {"deleted": event_id})
        raise AssertionError((origin, method, path))

    async def fake_websocket_echo(*_args, **_kwargs):
        return None

    monkeypatch.setattr(authenticated_smoke, "_request", fake_request)
    monkeypatch.setattr(authenticated_smoke, "_websocket_echo", fake_websocket_echo)

    report = asyncio.run(
        authenticated_smoke.run_authenticated_smoke(
            "https://render.example.com",
            "https://edge.example.com",
            "secret-token",
            run_id="residue-run",
        )
    )

    assert report["passed"] is False
    assert report["cleanup"] == {"attempted": True, "passed": False}
    assert any("cleanup left the smoke note" in failure for failure in report["failures"])


def test_cleanup_falls_back_to_render_after_mid_run_failure(monkeypatch):
    delete_targets = []

    def fake_request(origin, _token, method, path, **_kwargs):
        if method == "POST" and path == "/calendar/event":
            return _response(200, {"event": {"id": 77}})
        if method == "GET":
            raise authenticated_smoke.SmokeFailure("forced read failure")
        if method == "DELETE":
            delete_targets.append(origin)
            if origin.endswith("edge.example.com"):
                raise OSError("forced edge outage")
            return _response(200, {"deleted": 77})
        raise AssertionError((origin, method, path))

    monkeypatch.setattr(authenticated_smoke, "_request", fake_request)

    report = asyncio.run(
        authenticated_smoke.run_authenticated_smoke(
            "https://render.example.com",
            "https://edge.example.com",
            "secret-token",
            run_id="cleanup-run",
        )
    )

    assert report["passed"] is False
    assert report["cleanup"] == {"attempted": True, "passed": True}
    assert delete_targets == ["https://edge.example.com", "https://render.example.com"]
    assert any("forced read failure" in failure for failure in report["failures"])


def test_authenticated_workflow_is_manual_secret_safe_and_serialized():
    workflow = yaml.load(
        (ROOT / ".github" / "workflows" / "tests.yml").read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,
    )
    dispatch = workflow["on"]["workflow_dispatch"]["inputs"]
    job = workflow["jobs"]["authenticated-smoke"]
    run_step = next(step for step in job["steps"] if step.get("name") == "Run reversible authenticated smoke checks")
    upload_step = next(step for step in job["steps"] if step.get("name") == "Upload authenticated smoke report")

    assert dispatch["run_authenticated_smoke"]["default"] == "false"
    assert "inputs.run_authenticated_smoke" in job["if"]
    assert job["concurrency"] == {
        "group": "sherryjo-authenticated-smoke",
        "cancel-in-progress": "false",
    }
    assert job["env"] == {
        "SMOKE_EMAIL_SECRET_NAME": "SHERRYJO_SMOKE_EMAIL",
        "SMOKE_PASSWORD_SECRET_NAME": "SHERRYJO_SMOKE_PASSWORD",
    }
    assert run_step["env"] == {
        "SHERRYJO_SMOKE_EMAIL": "${{ secrets[env.SMOKE_EMAIL_SECRET_NAME] }}",
        "SHERRYJO_SMOKE_PASSWORD": "${{ secrets[env.SMOKE_PASSWORD_SECRET_NAME] }}",
    }
    assert "--allow-remote" in run_step["run"]
    assert "always()" in upload_step["if"]


def test_render_synthetic_reuses_cleanup_without_cloudflare_claims(monkeypatch):
    async def fake_smoke(render_url, cloudflare_url, token):
        assert render_url == cloudflare_url == "https://render.example.com"
        assert token == "temporary-token"
        return {
            "render_url": render_url,
            "cloudflare_url": cloudflare_url,
            "passed": True,
            "checks": ["render_create", "cloudflare_read", "cloudflare_websocket_echo"],
            "cleanup": {"attempted": True, "passed": True},
            "failures": [],
        }

    monkeypatch.setattr(render_synthetic, "run_authenticated_smoke", fake_smoke)

    report = asyncio.run(
        render_synthetic.run_render_synthetic(
            "https://render.example.com",
            "temporary-token",
        )
    )

    assert report["mode"] == "direct-render"
    assert report["target_url"] == "https://render.example.com"
    assert "cloudflare_url" not in report
    assert report["checks"] == [
        "render_create",
        "render_repeat_read",
        "render_repeat_websocket_echo",
    ]


def test_render_monitor_is_independent_default_disabled_and_secret_safe():
    workflow = yaml.load(
        (ROOT / ".github" / "workflows" / "render-hot-spare-monitor.yml").read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,
    )
    job = workflow["jobs"]["direct-render-synthetic"]
    run_step = next(step for step in job["steps"] if step.get("name") == "Run direct Render synthetic")

    assert "RENDER_HOT_SPARE_MONITOR_ENABLED" in job["if"]
    assert job["environment"] == "render-monitor"
    assert workflow["concurrency"] == {
        "group": "sherryjo-render-hot-spare-monitor",
        "cancel-in-progress": "false",
    }
    assert job["env"]["SHERRYJO_SMOKE_EMAIL"] == "${{ secrets.SHERRYJO_SMOKE_EMAIL }}"
    assert job["env"]["SHERRYJO_SMOKE_PASSWORD"] == "${{ secrets.SHERRYJO_SMOKE_PASSWORD }}"
    assert job["env"]["SHERRYJO_SMOKE_TOKEN"] == "${{ secrets.SHERRYJO_SMOKE_TOKEN }}"
    assert "--render-url" in run_step["run"]
    assert "missing_smoke_credentials" in run_step["run"]
    assert "cloudflare" not in run_step["run"].lower()


def test_render_synthetic_supports_workflow_script_invocation():
    result = subprocess.run(
        [sys.executable, "deployment/render_synthetic.py", "--help"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "--render-url" in result.stdout
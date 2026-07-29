"""
Tests for the log/usage reduction controls.

These guard the behaviours that keep free-tier quotas bounded: log levels are
centrally configurable, high-frequency access lines are dropped, routine TV
telemetry does not become permanent rows, and tv_diag_log is pruned.
"""

import logging
from datetime import datetime, timedelta, timezone

import pytest

from app.logging_config import (
    NoisyIcalFilter,
    QuietAccessFilter,
    configure_logging,
    resolve_log_level,
)
from app.routers import tv as tv_router


# ==================================================
# LOG LEVEL CONFIGURATION
# ==================================================

def test_log_level_env_var_wins(monkeypatch):
    monkeypatch.setenv("LOG_LEVEL", "error")

    assert resolve_log_level() == "ERROR"


def test_log_level_defaults_quiet_in_production(monkeypatch):
    monkeypatch.delenv("LOG_LEVEL", raising=False)
    monkeypatch.setattr("app.config.is_production_environment", lambda: True)

    assert resolve_log_level() == "WARNING"


def test_log_level_defaults_verbose_locally(monkeypatch):
    monkeypatch.delenv("LOG_LEVEL", raising=False)
    monkeypatch.setattr("app.config.is_production_environment", lambda: False)

    assert resolve_log_level() == "INFO"


def test_invalid_log_level_falls_back(monkeypatch):
    monkeypatch.setenv("LOG_LEVEL", "chatty")
    monkeypatch.setattr("app.config.is_production_environment", lambda: False)

    assert resolve_log_level() == "INFO"


def test_configure_logging_is_idempotent(monkeypatch):
    monkeypatch.setenv("LOG_LEVEL", "WARNING")

    configure_logging()
    configure_logging()

    access = logging.getLogger("uvicorn.access")
    assert sum(isinstance(f, QuietAccessFilter) for f in access.filters) == 1
    assert sum(isinstance(f, NoisyIcalFilter) for f in logging.getLogger().filters) == 1
    assert logging.getLogger("caldav").level == logging.WARNING


# ==================================================
# ACCESS LOG FILTERING
# ==================================================

def _access_record(path, status):
    return logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg='%s - "%s %s HTTP/%s" %d',
        args=("127.0.0.1:1", "POST", path, "1.1", status),
        exc_info=None,
    )


@pytest.mark.parametrize("path", ["/health", "/tv/diag", "/static/calendar.js"])
def test_quiet_access_filter_drops_successful_noise(path):
    assert QuietAccessFilter().filter(_access_record(path, 200)) is False


@pytest.mark.parametrize("path,status", [
    ("/tv/diag", 401),
    ("/health", 503),
    ("/calendar/unified", 200),
])
def test_quiet_access_filter_keeps_everything_else(path, status):
    assert QuietAccessFilter().filter(_access_record(path, status)) is True


def test_noisy_ical_filter_drops_library_chatter():
    record = logging.LogRecord(
        "caldav", logging.WARNING, __file__, 1,
        "Ical data was modified to avoid compatibility issues", (), None,
    )

    assert NoisyIcalFilter().filter(record) is False


# ==================================================
# TV DIAGNOSTIC PERSISTENCE POLICY
# ==================================================

@pytest.fixture(autouse=True)
def _clear_routine_state():
    tv_router._routine_persist_seen.clear()
    yield
    tv_router._routine_persist_seen.clear()


def test_signal_events_always_persist():
    assert tv_router._should_persist("raf_gap", "device-1") is True
    assert tv_router._should_persist("raf_gap", "device-1") is True


def test_routine_events_persist_once_per_interval():
    assert tv_router._should_persist("heartbeat", "device-1") is True
    assert tv_router._should_persist("heartbeat", "device-1") is False


def test_routine_throttle_is_per_device():
    assert tv_router._should_persist("heartbeat", "device-1") is True
    assert tv_router._should_persist("heartbeat", "device-2") is True


def test_routine_events_persist_again_after_interval(monkeypatch):
    monkeypatch.setenv("TV_DIAG_ROUTINE_PERSIST_MINUTES", "30")

    assert tv_router._should_persist("heartbeat", "device-1") is True
    tv_router._routine_persist_seen["device-1"] = datetime.now(timezone.utc) - timedelta(minutes=31)

    assert tv_router._should_persist("heartbeat", "device-1") is True


def test_persistence_can_be_disabled_entirely(monkeypatch):
    monkeypatch.setenv("TV_DIAG_PERSIST", "0")

    assert tv_router._should_persist("raf_gap", "device-1") is False


# ==================================================
# TV DIAGNOSTIC ENDPOINT
# ==================================================

def test_diag_accepts_a_batch(client, auth_headers):
    response = client.post(
        "/tv/diag",
        headers=auth_headers,
        json={"entries": [
            {"event": "session_start", "device_id": "d1"},
            {"event": "raf_gap", "device_id": "d1"},
        ]},
    )

    assert response.status_code == 200
    assert response.json()["accepted"] == 2


def test_diag_still_accepts_a_single_entry(client, auth_headers):
    response = client.post(
        "/tv/diag", headers=auth_headers, json={"event": "session_start", "device_id": "d1"}
    )

    assert response.status_code == 200
    assert response.json()["accepted"] == 1


def test_repeated_heartbeats_create_one_row(client, auth_headers):
    for _ in range(5):
        client.post("/tv/diag", headers=auth_headers,
                    json={"event": "heartbeat", "device_id": "kiosk-1"})

    rows = client.get("/tv/diag", headers=auth_headers).json()["entries"]
    persisted = [r for r in rows if r.get("event") == "heartbeat"]

    assert len(persisted) == 1


def test_diag_repair_risk_filter_returns_only_expected_scenarios(client, db, admin_headers):
    from app.models import TVDiagLog

    response = client.post(
        "/tv/diag",
        headers=admin_headers,
        json={
            "entries": [
                {"event": "token_invalid_401", "device_id": "d-repair"},
                {"event": "kiosk_token_invalid_401", "device_id": "d-repair"},
                {"event": "storage_token_removed", "device_id": "d-repair"},
                {"event": "user_unpair_requested", "device_id": "d-repair"},
                {"event": "heartbeat", "device_id": "d-repair"},
                {"event": "calendar_publish_result", "device_id": "d-repair"},
            ]
        },
    )
    assert response.status_code == 200
    assert response.json()["accepted"] == 6

    old_row = (
        db.query(TVDiagLog)
        .filter(TVDiagLog.event == "storage_token_removed")
        .order_by(TVDiagLog.ts_server.desc())
        .first()
    )
    assert old_row is not None
    old_row.ts_server = datetime.now(timezone.utc) - timedelta(hours=48)
    db.commit()

    filtered = client.get(
        "/tv/diag",
        headers=admin_headers,
        params={"scope": "all", "event_group": "repair_risk", "hours": 24},
    )
    assert filtered.status_code == 200

    payload = filtered.json()
    events = [entry.get("event") for entry in payload.get("entries", [])]
    expected = {
        "token_invalid_401",
        "kiosk_token_invalid_401",
        "storage_token_removed",
        "user_unpair_requested",
    }

    assert set(events).issubset(expected)
    assert "storage_token_removed" not in events
    assert {"token_invalid_401", "kiosk_token_invalid_401", "user_unpair_requested"}.issubset(set(events))
    assert payload.get("filters", {}).get("event_group") == "repair_risk"
    assert payload.get("filters", {}).get("hours") == 24


# ==================================================
# RETENTION
# ==================================================

def test_prune_removes_only_expired_rows(monkeypatch, db):
    from app.models import TVDiagLog
    from app.services import sync_scheduler

    monkeypatch.setenv("TV_DIAG_RETENTION_DAYS", "7")
    monkeypatch.setattr(sync_scheduler, "SessionLocal", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)

    now = datetime.now(timezone.utc)
    db.add(TVDiagLog(event="old", ts_server=now - timedelta(days=30)))
    db.add(TVDiagLog(event="fresh", ts_server=now - timedelta(days=1)))
    db.commit()

    sync_scheduler.prune_tv_diag_log()

    remaining = [row.event for row in db.query(TVDiagLog).all()]
    assert remaining == ["fresh"]

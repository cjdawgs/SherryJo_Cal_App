from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.services import sync_scheduler


NOW = datetime(2026, 1, 10, 12, 0, tzinfo=timezone.utc)


def _account(**kwargs):
    defaults = {
        "provider": "google",
        "sync_frequency_minutes": 5,
        "sync_range_days": 30,
        "last_sync": NOW - timedelta(hours=1),
        "last_sync_success": NOW - timedelta(hours=1),
        "last_manual_refresh_at": None,
    }
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


@pytest.fixture
def reset_phase1_state(monkeypatch):
    sync_scheduler._sync_efficiency_counters["changes"] = 0
    sync_scheduler._sync_efficiency_counters["no_changes"] = 0
    monkeypatch.delenv("SYNC_ADAPTIVE_BACKOFF_ENABLED", raising=False)
    monkeypatch.delenv("SYNC_ADAPTIVE_BACKOFF_MAX_MINUTES", raising=False)
    yield
    sync_scheduler._sync_efficiency_counters["changes"] = 0
    sync_scheduler._sync_efficiency_counters["no_changes"] = 0


# ==================================================
# RANGE COMPUTATION
# ==================================================

def test_compute_sync_window_days_uses_max_account_window_and_clamps(reset_phase1_state):
    accounts = [_account(sync_range_days=7), _account(sync_range_days=45), _account(sync_range_days=900)]

    window_days = sync_scheduler._compute_sync_window_days(accounts)

    assert window_days == 900


def test_build_sync_window_uses_symmetric_day_range(reset_phase1_state):
    start_date, end_date = sync_scheduler._build_sync_window(21, NOW)

    assert (NOW - start_date).days == 21
    assert (end_date - NOW).days == 21


# ==================================================
# EFFICIENCY COUNTERS
# ==================================================

def test_sync_efficiency_counters_track_changes_and_no_changes(reset_phase1_state):
    sync_scheduler._record_sync_efficiency(False)
    sync_scheduler._record_sync_efficiency(True)

    assert sync_scheduler._sync_efficiency_counters["no_changes"] == 1
    assert sync_scheduler._sync_efficiency_counters["changes"] == 1

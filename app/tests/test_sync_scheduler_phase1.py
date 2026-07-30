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
    sync_scheduler._no_change_streak_by_user.clear()
    sync_scheduler._next_due_override_by_user.clear()
    sync_scheduler._sync_efficiency_counters["changes"] = 0
    sync_scheduler._sync_efficiency_counters["no_changes"] = 0
    monkeypatch.delenv("SYNC_ADAPTIVE_BACKOFF_ENABLED", raising=False)
    monkeypatch.delenv("SYNC_ADAPTIVE_BACKOFF_MAX_MINUTES", raising=False)
    yield
    sync_scheduler._no_change_streak_by_user.clear()
    sync_scheduler._next_due_override_by_user.clear()
    sync_scheduler._sync_efficiency_counters["changes"] = 0
    sync_scheduler._sync_efficiency_counters["no_changes"] = 0


# ==================================================
# RANGE COMPUTATION
# ==================================================

def test_compute_sync_window_days_uses_max_account_window_and_clamps(reset_phase1_state):
    accounts = [_account(sync_range_days=7), _account(sync_range_days=45), _account(sync_range_days=900)]

    window_days = sync_scheduler._compute_sync_window_days(accounts)

    assert window_days == 365


def test_build_sync_window_uses_symmetric_day_range(reset_phase1_state):
    start_date, end_date = sync_scheduler._build_sync_window(21, NOW)

    assert (NOW - start_date).days == 21
    assert (end_date - NOW).days == 21


# ==================================================
# ADAPTIVE BACKOFF ESCALATION / RESET
# ==================================================

def test_adaptive_backoff_escalates_then_resets_on_change(reset_phase1_state, monkeypatch):
    monkeypatch.setenv("SYNC_ADAPTIVE_BACKOFF_ENABLED", "1")
    monkeypatch.setenv("SYNC_ADAPTIVE_BACKOFF_MAX_MINUTES", "60")

    user_id = 41
    accounts = [_account(sync_frequency_minutes=5)]

    sync_scheduler._register_sync_outcome(user_id=user_id, accounts=accounts, had_changes=False, now=NOW)
    first_due = sync_scheduler._next_due_override_by_user[user_id]
    assert first_due == NOW + timedelta(minutes=10)
    assert sync_scheduler._no_change_streak_by_user[user_id] == 1

    sync_scheduler._register_sync_outcome(user_id=user_id, accounts=accounts, had_changes=False, now=NOW)
    second_due = sync_scheduler._next_due_override_by_user[user_id]
    assert second_due == NOW + timedelta(minutes=20)
    assert sync_scheduler._no_change_streak_by_user[user_id] == 2

    sync_scheduler._register_sync_outcome(user_id=user_id, accounts=accounts, had_changes=True, now=NOW)
    assert sync_scheduler._no_change_streak_by_user[user_id] == 0
    assert sync_scheduler._next_due_override_by_user.get(user_id) is None


def test_is_user_sync_due_respects_backoff_override(reset_phase1_state, monkeypatch):
    monkeypatch.setenv("SYNC_ADAPTIVE_BACKOFF_ENABLED", "1")

    user_id = 77
    accounts = [_account(sync_frequency_minutes=5)]
    sync_scheduler._next_due_override_by_user[user_id] = NOW + timedelta(minutes=9)

    due, cadence = sync_scheduler._is_user_sync_due(user_id, accounts, NOW)

    assert due is False
    assert cadence == 5


# ==================================================
# KILL SWITCH
# ==================================================

def test_adaptive_backoff_kill_switch_disables_override(reset_phase1_state, monkeypatch):
    monkeypatch.setenv("SYNC_ADAPTIVE_BACKOFF_ENABLED", "0")

    user_id = 55
    accounts = [_account(sync_frequency_minutes=5)]

    sync_scheduler._register_sync_outcome(user_id=user_id, accounts=accounts, had_changes=False, now=NOW)

    assert user_id not in sync_scheduler._next_due_override_by_user
    assert user_id not in sync_scheduler._no_change_streak_by_user


# ==================================================
# EFFICIENCY COUNTERS
# ==================================================

def test_sync_efficiency_counters_track_changes_and_no_changes(reset_phase1_state):
    accounts = [_account()]

    sync_scheduler._register_sync_outcome(user_id=1, accounts=accounts, had_changes=False, now=NOW)
    sync_scheduler._register_sync_outcome(user_id=1, accounts=accounts, had_changes=True, now=NOW)

    assert sync_scheduler._sync_efficiency_counters["no_changes"] == 1
    assert sync_scheduler._sync_efficiency_counters["changes"] == 1

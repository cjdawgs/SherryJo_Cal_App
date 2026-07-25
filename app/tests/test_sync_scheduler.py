from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.services import sync_scheduler


NOW = datetime(2026, 1, 10, 12, 0, tzinfo=timezone.utc)


def make_account(**kwargs):
    defaults = {
        "sync_frequency_minutes": 5,
        "last_sync": None,
        "last_sync_success": None,
        "last_manual_refresh_at": None,
    }
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


class FakeQuery:
    """Minimal SQLAlchemy query stand-in that ignores filters."""

    def __init__(self, rows):
        self._rows = rows

    def filter(self, *args, **kwargs):
        return self

    def join(self, *args, **kwargs):
        return self

    def distinct(self, *args, **kwargs):
        return self

    def all(self):
        return self._rows


class RoutingSession:
    """Session stand-in that returns per-user accounts in user iteration order."""

    def __init__(self, users, accounts_by_user_id, users_error=None):
        self.users = users
        self.users_error = users_error
        self.accounts_by_user_id = accounts_by_user_id
        self.requested_users = []
        self.closed = False

    def close(self):
        self.closed = True

    def query(self, model):
        if model is sync_scheduler.User:
            if self.users_error:
                raise self.users_error
            return FakeQuery(self.users)

        # run_event_sync queries accounts once per user, in user order.
        index = len(self.requested_users)
        user = self.users[index] if index < len(self.users) else None
        self.requested_users.append(user)
        return FakeQuery(self.accounts_by_user_id.get(getattr(user, "id", None), []))


@pytest.fixture
def reset_sync_state():
    sync_scheduler.last_global_sync_started_at = None
    sync_scheduler.last_global_sync_finished_at = None
    sync_scheduler.last_global_sync_error = None
    yield
    sync_scheduler.last_global_sync_started_at = None
    sync_scheduler.last_global_sync_finished_at = None
    sync_scheduler.last_global_sync_error = None


# ==================================================
# VERBOSE FLAG
# ==================================================

@pytest.mark.parametrize("value,expected", [
    ("1", True),
    ("true", True),
    ("YES", True),
    (" on ", True),
    ("0", False),
    ("nope", False),
])
def test_verbose_sync_console(monkeypatch, value, expected):
    monkeypatch.setenv("SYNC_CONSOLE_VERBOSE", value)

    assert sync_scheduler._verbose_sync_console() is expected


def test_verbose_sync_console_defaults_off(monkeypatch):
    monkeypatch.delenv("SYNC_CONSOLE_VERBOSE", raising=False)

    assert sync_scheduler._verbose_sync_console() is False


# ==================================================
# SYNC MARKERS
# ==================================================

def test_latest_account_sync_marker_picks_newest():
    account = make_account(
        last_sync=NOW - timedelta(hours=2),
        last_sync_success=NOW - timedelta(minutes=30),
        last_manual_refresh_at=NOW - timedelta(hours=1),
    )

    assert sync_scheduler._latest_account_sync_marker(account) == NOW - timedelta(minutes=30)


def test_latest_account_sync_marker_makes_naive_datetimes_utc():
    account = make_account(last_sync=datetime(2026, 1, 10, 11, 0))

    marker = sync_scheduler._latest_account_sync_marker(account)

    assert marker == datetime(2026, 1, 10, 11, 0, tzinfo=timezone.utc)


def test_latest_account_sync_marker_without_history():
    assert sync_scheduler._latest_account_sync_marker(make_account()) is None


# ==================================================
# CADENCE
# ==================================================

def test_sync_not_due_without_accounts():
    assert sync_scheduler._is_user_sync_due([], NOW) == (False, None)


def test_sync_due_when_never_synced():
    due, cadence = sync_scheduler._is_user_sync_due([make_account()], NOW)

    assert (due, cadence) == (True, 5)


def test_sync_uses_shortest_cadence_and_floors_at_one_minute():
    accounts = [
        make_account(sync_frequency_minutes=15, last_sync=NOW - timedelta(minutes=3)),
        make_account(sync_frequency_minutes=-10, last_sync=NOW - timedelta(minutes=3)),
    ]

    due, cadence = sync_scheduler._is_user_sync_due(accounts, NOW)

    assert (due, cadence) == (True, 1)


def test_sync_cadence_falls_back_to_five_minutes_when_unset():
    accounts = [make_account(sync_frequency_minutes=0, last_sync=NOW - timedelta(minutes=3))]

    due, cadence = sync_scheduler._is_user_sync_due(accounts, NOW)

    assert (due, cadence) == (False, 5)


def test_sync_not_due_before_cadence_elapses():
    accounts = [make_account(sync_frequency_minutes=30, last_sync=NOW - timedelta(minutes=5))]

    due, cadence = sync_scheduler._is_user_sync_due(accounts, NOW)

    assert (due, cadence) == (False, 30)


def test_sync_due_once_cadence_elapsed():
    accounts = [make_account(sync_frequency_minutes=10, last_sync=NOW - timedelta(minutes=10))]

    due, _ = sync_scheduler._is_user_sync_due(accounts, NOW)

    assert due is True


# ==================================================
# RUN EVENT SYNC
# ==================================================

def test_run_event_sync_without_users(monkeypatch, reset_sync_state):
    session = RoutingSession(users=[], accounts_by_user_id={})
    monkeypatch.setattr(sync_scheduler, "SessionLocal", lambda: session)
    sync_all = MagicMock()
    monkeypatch.setattr(sync_scheduler.calendar_service, "sync_all", sync_all)

    sync_scheduler.run_event_sync()

    sync_all.assert_not_called()
    assert session.closed is True
    assert sync_scheduler.last_global_sync_started_at is not None
    assert sync_scheduler.last_global_sync_finished_at is not None


def test_run_event_sync_skips_users_not_due(monkeypatch, reset_sync_state):
    user = SimpleNamespace(id=1)
    session = RoutingSession(
        users=[user],
        accounts_by_user_id={
            1: [make_account(sync_frequency_minutes=60, last_sync=datetime.now(timezone.utc))]
        },
    )
    monkeypatch.setattr(sync_scheduler, "SessionLocal", lambda: session)
    sync_all = MagicMock()
    monkeypatch.setattr(sync_scheduler.calendar_service, "sync_all", sync_all)

    sync_scheduler.run_event_sync()

    sync_all.assert_not_called()


def test_run_event_sync_syncs_due_users_and_skips_accountless(monkeypatch, reset_sync_state):
    due_user = SimpleNamespace(id=1)
    accountless_user = SimpleNamespace(id=2)
    session = RoutingSession(
        users=[due_user, accountless_user],
        accounts_by_user_id={1: [make_account()], 2: []},
    )
    monkeypatch.setattr(sync_scheduler, "SessionLocal", lambda: session)
    sync_all = MagicMock(return_value={"synced": 3})
    monkeypatch.setattr(sync_scheduler.calendar_service, "sync_all", sync_all)

    sync_scheduler.run_event_sync()

    sync_all.assert_called_once_with(session, due_user)
    assert sync_scheduler.last_global_sync_error is None


def test_run_event_sync_continues_after_user_failure(monkeypatch, reset_sync_state, caplog):
    failing_user = SimpleNamespace(id=1)
    ok_user = SimpleNamespace(id=2)
    session = RoutingSession(
        users=[failing_user, ok_user],
        accounts_by_user_id={1: [make_account()], 2: [make_account()]},
    )
    monkeypatch.setattr(sync_scheduler, "SessionLocal", lambda: session)

    def sync_all(db, user):
        if user is failing_user:
            raise RuntimeError("provider down")
        return {"synced": 1}

    monkeypatch.setattr(sync_scheduler.calendar_service, "sync_all", sync_all)

    with caplog.at_level("ERROR", logger="app.services.sync_scheduler"):
        sync_scheduler.run_event_sync()

    assert "user=1 FAILED: provider down" in caplog.text
    assert sync_scheduler.last_global_sync_error is None


def test_run_event_sync_records_global_failure(monkeypatch, reset_sync_state):
    session = RoutingSession(users=[], accounts_by_user_id={}, users_error=RuntimeError("db gone"))
    monkeypatch.setattr(sync_scheduler, "SessionLocal", lambda: session)

    sync_scheduler.run_event_sync()

    assert sync_scheduler.last_global_sync_error == "db gone"
    assert session.closed is True


def test_run_event_sync_verbose_prints_results(monkeypatch, reset_sync_state, caplog):
    monkeypatch.setenv("SYNC_CONSOLE_VERBOSE", "1")
    user = SimpleNamespace(id=7)
    session = RoutingSession(users=[user], accounts_by_user_id={7: [make_account()]})
    monkeypatch.setattr(sync_scheduler, "SessionLocal", lambda: session)
    monkeypatch.setattr(
        sync_scheduler.calendar_service, "sync_all", MagicMock(return_value={"synced": 2})
    )

    with caplog.at_level("INFO", logger="app.services.sync_scheduler"):
        sync_scheduler.run_event_sync()

    assert "[SYNC] user=7 {'synced': 2}" in caplog.text


# ==================================================
# SCHEDULER LIFECYCLE
# ==================================================

def test_start_scheduler_registers_job(monkeypatch):
    scheduler = MagicMock()
    monkeypatch.setattr(sync_scheduler, "scheduler", scheduler)

    sync_scheduler.start_scheduler()

    jobs = {call[1]["id"]: call[1] for call in scheduler.add_job.call_args_list}
    assert jobs["event_sync_job"]["minutes"] == 5
    assert jobs["event_sync_job"]["replace_existing"] is True
    assert jobs["tv_diag_prune_job"]["hours"] == 24
    scheduler.start.assert_called_once()


def test_get_scheduler_health_reports_next_run(monkeypatch, reset_sync_state):
    job = SimpleNamespace(next_run_time=NOW + timedelta(minutes=5))
    monkeypatch.setattr(
        sync_scheduler, "scheduler", SimpleNamespace(running=True, get_job=lambda _id: job)
    )
    sync_scheduler.last_global_sync_started_at = NOW
    sync_scheduler.last_global_sync_finished_at = NOW + timedelta(seconds=30)

    health = sync_scheduler.get_scheduler_health()

    assert health["running"] is True
    assert health["last_started_at"] == NOW.isoformat()
    assert health["last_finished_at"] == (NOW + timedelta(seconds=30)).isoformat()
    assert health["next_run_at"] == (NOW + timedelta(minutes=5)).isoformat()
    assert health["frequency_minutes"] == 5
    assert health["last_error"] is None


def test_get_scheduler_health_handles_lookup_failure(monkeypatch, reset_sync_state):
    def boom(_id):
        raise RuntimeError("scheduler not started")

    monkeypatch.setattr(
        sync_scheduler, "scheduler", SimpleNamespace(running=False, get_job=boom)
    )

    health = sync_scheduler.get_scheduler_health()

    assert health["next_run_at"] is None
    assert health["running"] is False
    assert health["last_started_at"] is None

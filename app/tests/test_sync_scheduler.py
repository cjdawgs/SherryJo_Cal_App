from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.models import SyncEfficiencyDailyRollup, SyncOperationLedger, TVDiagLog
from app.services import sync_scheduler
from app.services.google_calendar_service import GoogleCalendarService


NOW = datetime(2026, 1, 10, 12, 0, tzinfo=timezone.utc)


def make_account(**kwargs):
    defaults = {
        "access_token": "healthy-token",
        "provider": "google",
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
    sync_scheduler._no_change_streak_by_user.clear()
    sync_scheduler._next_due_override_by_user.clear()
    sync_scheduler._sync_efficiency_counters["changes"] = 0
    sync_scheduler._sync_efficiency_counters["no_changes"] = 0
    yield
    sync_scheduler.last_global_sync_started_at = None
    sync_scheduler.last_global_sync_finished_at = None
    sync_scheduler.last_global_sync_error = None
    sync_scheduler._no_change_streak_by_user.clear()
    sync_scheduler._next_due_override_by_user.clear()
    sync_scheduler._sync_efficiency_counters["changes"] = 0
    sync_scheduler._sync_efficiency_counters["no_changes"] = 0


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
    assert sync_scheduler._is_user_sync_due(1, [], NOW) == (False, None)


def test_sync_due_when_never_synced():
    due, cadence = sync_scheduler._is_user_sync_due(1, [make_account()], NOW)

    assert (due, cadence) == (True, 5)


def test_sync_uses_shortest_cadence_and_floors_at_one_minute():
    accounts = [
        make_account(sync_frequency_minutes=15, last_sync=NOW - timedelta(minutes=3)),
        make_account(sync_frequency_minutes=-10, last_sync=NOW - timedelta(minutes=3)),
    ]

    due, cadence = sync_scheduler._is_user_sync_due(1, accounts, NOW)

    assert (due, cadence) == (True, 1)


def test_sync_cadence_falls_back_to_five_minutes_when_unset():
    accounts = [make_account(sync_frequency_minutes=0, last_sync=NOW - timedelta(minutes=3))]

    due, cadence = sync_scheduler._is_user_sync_due(1, accounts, NOW)

    assert (due, cadence) == (False, 5)


def test_sync_not_due_before_cadence_elapses():
    accounts = [make_account(sync_frequency_minutes=30, last_sync=NOW - timedelta(minutes=5))]

    due, cadence = sync_scheduler._is_user_sync_due(1, accounts, NOW)

    assert (due, cadence) == (False, 30)


def test_sync_due_once_cadence_elapsed():
    accounts = [make_account(sync_frequency_minutes=10, last_sync=NOW - timedelta(minutes=10))]

    due, _ = sync_scheduler._is_user_sync_due(1, accounts, NOW)

    assert due is True


def test_sync_operation_key_uses_latest_marker_anchor():
    accounts = [
        make_account(last_sync=NOW - timedelta(minutes=20)),
        make_account(last_sync_success=NOW - timedelta(minutes=5)),
    ]

    key = sync_scheduler._sync_operation_key(37, accounts)

    assert key == f"scheduler-sync:user:37:anchor:{int((NOW - timedelta(minutes=5)).timestamp())}"


def test_sync_operation_key_uses_bootstrap_anchor_without_markers():
    key = sync_scheduler._sync_operation_key(7, [make_account()])

    assert key == "scheduler-sync:user:7:anchor:bootstrap"


def test_sync_operation_max_attempts_defaults_and_parses_env(monkeypatch):
    monkeypatch.delenv("SYNC_OPERATION_MAX_ATTEMPTS", raising=False)
    assert sync_scheduler._sync_operation_max_attempts() == 3

    monkeypatch.setenv("SYNC_OPERATION_MAX_ATTEMPTS", "5")
    assert sync_scheduler._sync_operation_max_attempts() == 5

    monkeypatch.setenv("SYNC_OPERATION_MAX_ATTEMPTS", "bad")
    assert sync_scheduler._sync_operation_max_attempts() == 3


def test_sync_uses_provider_floor_for_apple_cadence(monkeypatch):
    monkeypatch.setenv("SYNC_APPLE_MIN_FREQUENCY_MINUTES", "240")
    accounts = [
        make_account(provider="apple", sync_frequency_minutes=5, last_sync=NOW - timedelta(minutes=120)),
    ]

    due, cadence = sync_scheduler._is_user_sync_due(1, accounts, NOW)

    assert due is False
    assert cadence == 240


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


def test_run_event_sync_skips_dead_letter_operation_key(monkeypatch, reset_sync_state):
    user = SimpleNamespace(id=1)
    session = RoutingSession(users=[user], accounts_by_user_id={1: [make_account()]})
    monkeypatch.setattr(sync_scheduler, "SessionLocal", lambda: session)
    monkeypatch.setattr(sync_scheduler, "is_operation_dead_letter", lambda _db, operation_key: True)
    sync_all = MagicMock()
    monkeypatch.setattr(sync_scheduler.calendar_service, "sync_all", sync_all)

    sync_scheduler.run_event_sync()

    sync_all.assert_not_called()


def test_run_event_sync_skips_same_dead_letter_key_across_cycles(monkeypatch, reset_sync_state):
    user = SimpleNamespace(id=1)
    seen_keys = []

    def _dead_letter(_db, operation_key):
        seen_keys.append(operation_key)
        return True

    monkeypatch.setattr(
        sync_scheduler,
        "SessionLocal",
        lambda: RoutingSession(users=[user], accounts_by_user_id={1: [make_account()]}),
    )
    monkeypatch.setattr(sync_scheduler, "is_operation_dead_letter", _dead_letter)
    sync_all = MagicMock()
    monkeypatch.setattr(sync_scheduler.calendar_service, "sync_all", sync_all)

    sync_scheduler.run_event_sync()
    sync_scheduler.run_event_sync()

    assert len(seen_keys) == 2
    assert seen_keys[0] == seen_keys[1]
    sync_all.assert_not_called()


def test_run_event_sync_skips_user_with_only_reauth_required_accounts(
    monkeypatch, reset_sync_state
):
    user = SimpleNamespace(id=1)
    session = RoutingSession(
        users=[user],
        accounts_by_user_id={
            1: [make_account(access_token="__REAUTH_REQUIRED__")]
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
    sync_all = MagicMock(return_value={"created": 0, "updated": 0, "deleted": 0, "deduped": 0})
    monkeypatch.setattr(sync_scheduler.calendar_service, "sync_all", sync_all)

    sync_scheduler.run_event_sync()

    sync_all.assert_called_once()
    kwargs = sync_all.call_args.kwargs
    assert kwargs.get("start_date") is not None
    assert kwargs.get("end_date") is not None
    assert sync_scheduler.last_global_sync_error is None


def test_run_event_sync_continues_after_user_failure(monkeypatch, reset_sync_state, caplog):
    failing_user = SimpleNamespace(id=1)
    ok_user = SimpleNamespace(id=2)
    session = RoutingSession(
        users=[failing_user, ok_user],
        accounts_by_user_id={1: [make_account()], 2: [make_account()]},
    )
    monkeypatch.setattr(sync_scheduler, "SessionLocal", lambda: session)

    def sync_all(db, user, start_date=None, end_date=None):
        if user is failing_user:
            raise RuntimeError("provider down")
        return {"created": 0, "updated": 1, "deleted": 0, "deduped": 0}

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
        sync_scheduler.calendar_service,
        "sync_all",
        MagicMock(return_value={"created": 1, "updated": 0, "deleted": 0, "deduped": 0}),
    )

    with caplog.at_level("INFO", logger="app.services.sync_scheduler"):
        sync_scheduler.run_event_sync()

    assert "[SYNC] user=7 {'created': 1, 'updated': 0, 'deleted': 0, 'deduped': 0}" in caplog.text


# ==================================================
# SCHEDULER LIFECYCLE
# ==================================================

def test_start_scheduler_registers_job(monkeypatch):
    scheduler = MagicMock()
    monkeypatch.setattr(sync_scheduler, "scheduler", scheduler)
    monkeypatch.setenv("SYNC_SCHEDULER_HEARTBEAT_MINUTES", "7")

    sync_scheduler.start_scheduler()

    jobs = {call[1]["id"]: call[1] for call in scheduler.add_job.call_args_list}
    assert jobs["event_sync_job"]["minutes"] == 7
    assert jobs["event_sync_job"]["replace_existing"] is True
    assert jobs["tv_diag_prune_job"]["hours"] == 24
    assert jobs["sync_efficiency_rollup_job"]["hour"] == 0
    assert jobs["sync_efficiency_rollup_job"]["minute"] == 5
    scheduler.start.assert_called_once()


def test_start_scheduler_skips_when_owner_is_not_render(monkeypatch):
    scheduler = MagicMock()
    monkeypatch.setattr(sync_scheduler, "scheduler", scheduler)
    monkeypatch.setenv("SYNC_SCHEDULER_OWNER", "cloudflare")

    sync_scheduler.start_scheduler()

    scheduler.add_job.assert_not_called()
    scheduler.start.assert_not_called()


def test_scheduler_owner_and_execution_enabled(monkeypatch):
    monkeypatch.delenv("SYNC_SCHEDULER_OWNER", raising=False)
    assert sync_scheduler._scheduler_owner() == "render"
    assert sync_scheduler._scheduler_execution_enabled() is True

    monkeypatch.setenv("SYNC_SCHEDULER_OWNER", "cloudflare")
    assert sync_scheduler._scheduler_owner() == "cloudflare"
    assert sync_scheduler._scheduler_execution_enabled() is False


def test_prune_tv_diag_log_deletes_only_expired_rows(monkeypatch, db):
    expired = TVDiagLog(
        ts_server=datetime.now(timezone.utc) - timedelta(days=30),
        event="expired",
    )
    current = TVDiagLog(
        ts_server=datetime.now(timezone.utc) - timedelta(days=1),
        event="current",
    )
    db.add_all([expired, current])
    db.commit()
    monkeypatch.setenv("TV_DIAG_RETENTION_DAYS", "14")
    monkeypatch.setattr(sync_scheduler, "SessionLocal", lambda: db)

    sync_scheduler.prune_tv_diag_log()

    assert [row.event for row in db.query(TVDiagLog).all()] == ["current"]
    ledger_rows = db.query(SyncOperationLedger).filter(SyncOperationLedger.operation_type == "scheduler_tv_diag_prune").all()
    assert len(ledger_rows) == 1
    assert ledger_rows[0].status == "succeeded"
    assert ledger_rows[0].result_payload["deleted_rows"] == 1


def test_prune_tv_diag_log_skips_dead_letter_operation_key(monkeypatch, db):
    expired = TVDiagLog(
        ts_server=datetime.now(timezone.utc) - timedelta(days=30),
        event="expired",
    )
    current = TVDiagLog(
        ts_server=datetime.now(timezone.utc) - timedelta(days=1),
        event="current",
    )
    db.add_all([expired, current])
    db.commit()

    monkeypatch.setenv("TV_DIAG_RETENTION_DAYS", "14")
    monkeypatch.setattr(sync_scheduler, "SessionLocal", lambda: db)
    monkeypatch.setattr(sync_scheduler, "is_operation_dead_letter", lambda _db, operation_key: True)

    sync_scheduler.prune_tv_diag_log()

    assert sorted(row.event for row in db.query(TVDiagLog).all()) == ["current", "expired"]
    assert db.query(SyncOperationLedger).filter(SyncOperationLedger.operation_type == "scheduler_tv_diag_prune").count() == 0


def test_sync_efficiency_rollup_updates_one_row_per_day(monkeypatch, db, reset_sync_state):
    monkeypatch.setattr(sync_scheduler, "SessionLocal", lambda: db)
    monkeypatch.setattr(
        GoogleCalendarService,
        "get_calendar_list_cache_metrics",
        lambda: {
            "hits": 3,
            "misses": 1,
            "total_lookups": 4,
            "hit_ratio": 0.75,
            "cache_entries": 2,
        },
    )
    sync_scheduler._sync_efficiency_counters.update(changes=2, no_changes=6)

    sync_scheduler.persist_sync_efficiency_rollup()
    sync_scheduler._sync_efficiency_counters.update(changes=3, no_changes=7)
    sync_scheduler.persist_sync_efficiency_rollup()

    rows = db.query(SyncEfficiencyDailyRollup).all()
    assert len(rows) == 1
    assert rows[0].changes == 3
    assert rows[0].no_changes == 7
    assert rows[0].total_cycles == 10
    assert rows[0].google_cache_hit_ratio == 0.75
    assert sync_scheduler.last_rollup_persisted_at is not None

    ledger_rows = db.query(SyncOperationLedger).filter(SyncOperationLedger.operation_type == "scheduler_rollup").all()
    assert len(ledger_rows) == 1
    assert ledger_rows[0].attempt_count == 2
    assert ledger_rows[0].status == "succeeded"
    assert ledger_rows[0].result_payload["total_cycles"] == 10


def test_sync_efficiency_rollup_skips_dead_letter_operation_key(monkeypatch, db, reset_sync_state):
    monkeypatch.setattr(sync_scheduler, "SessionLocal", lambda: db)
    monkeypatch.setattr(sync_scheduler, "is_operation_dead_letter", lambda _db, operation_key: True)
    sync_scheduler._sync_efficiency_counters.update(changes=2, no_changes=6)

    sync_scheduler.persist_sync_efficiency_rollup()

    assert db.query(SyncEfficiencyDailyRollup).count() == 0
    assert db.query(SyncOperationLedger).filter(SyncOperationLedger.operation_type == "scheduler_rollup").count() == 0


def test_get_scheduler_health_reports_next_run(monkeypatch, reset_sync_state):
    job = SimpleNamespace(next_run_time=NOW + timedelta(minutes=5))
    monkeypatch.setattr(
        sync_scheduler, "scheduler", SimpleNamespace(running=True, get_job=lambda _id: job)
    )
    sync_scheduler.last_global_sync_started_at = NOW
    sync_scheduler.last_global_sync_finished_at = NOW + timedelta(seconds=30)

    health = sync_scheduler.get_scheduler_health()

    assert health["running"] is True
    assert health["owner"] == "render"
    assert health["execution_enabled"] is True
    assert health["last_started_at"] == NOW.isoformat()
    assert health["last_finished_at"] == (NOW + timedelta(seconds=30)).isoformat()
    assert health["next_run_at"] == (NOW + timedelta(minutes=5)).isoformat()
    assert health["frequency_minutes"] == 5
    assert health["apple_min_frequency_minutes"] == 240
    assert health["last_error"] is None
    assert "operation_ledger" in health
    assert health["operation_ledger"]["window_hours"] == 24
    assert "total_operations" in health["operation_ledger"]
    assert "created_in_window" in health["operation_ledger"]
    assert "adaptive_backoff" in health
    assert "efficiency" in health
    assert "google_calendar_list_cache" in health


def test_get_scheduler_health_handles_lookup_failure(monkeypatch, reset_sync_state):
    def boom(_id):
        raise RuntimeError("scheduler not started")

    monkeypatch.setattr(
        sync_scheduler, "scheduler", SimpleNamespace(running=False, get_job=boom)
    )

    health = sync_scheduler.get_scheduler_health()

    assert health["next_run_at"] is None
    assert health["running"] is False
    assert health["owner"] == "render"
    assert health["execution_enabled"] is True
    assert "operation_ledger" in health
    assert health["operation_ledger"]["window_hours"] == 24
    assert health["last_started_at"] is None


def test_run_event_sync_passes_window_days_from_accounts(monkeypatch, reset_sync_state):
    user = SimpleNamespace(id=11)
    account = make_account(sync_frequency_minutes=5, sync_range_days=21)
    session = RoutingSession(users=[user], accounts_by_user_id={11: [account]})
    monkeypatch.setattr(sync_scheduler, "SessionLocal", lambda: session)

    sync_all = MagicMock(return_value={"created": 0, "updated": 0, "deleted": 0, "deduped": 0})
    monkeypatch.setattr(sync_scheduler.calendar_service, "sync_all", sync_all)

    sync_scheduler.run_event_sync()

    kwargs = sync_all.call_args.kwargs
    start_date = kwargs["start_date"]
    end_date = kwargs["end_date"]
    assert start_date is not None and end_date is not None
    assert (end_date - start_date).days == 42

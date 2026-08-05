# ==================================================
# BACKGROUND SYNC SCHEDULER
# ==================================================

"""
This file runs your automatic background sync.

Every X minutes:
    - It looks at ALL users
    - Syncs THEIR Google + Microsoft events
    - Saves results to database

Think of it like a robot that wakes up every 5 minutes
and updates everyone's calendar 🧸
"""

# ==================================================
# IMPORTS
# ==================================================

import logging
from apscheduler.schedulers.background import BackgroundScheduler
from contextlib import redirect_stdout
import io
import os
from sqlalchemy import func
from app.database import SessionLocal
from app.services.calendar_service import CalendarService
from app.services.sync_operation_ledger import (
    SYNC_ROLLUP_OPERATION_TYPE,
    SYNC_TV_DIAG_PRUNE_OPERATION_TYPE,
    begin_sync_operation,
    complete_sync_operation,
    is_operation_dead_letter,
)
from app.models import (
    User,
    OAuthAccount,
    TVDiagLog,
    SyncEfficiencyDailyRollup,
    SyncOperationLedger,
)   # ✅ VERY IMPORTANT (we loop users)
from datetime import datetime, timezone, timedelta

logger = logging.getLogger(__name__)


# ==================================================
# SETUP
# ==================================================

scheduler = BackgroundScheduler()
calendar_service = CalendarService()
last_global_sync_started_at = None
last_global_sync_finished_at = None
last_global_sync_error = None

DEFAULT_SYNC_HEARTBEAT_MINUTES = 5
DEFAULT_APPLE_MIN_SYNC_MINUTES = 240

# In-memory adaptive throttling state.
# Keys are user IDs so each user can independently back off when their calendar
# repeatedly returns no changes.
_no_change_streak_by_user: dict[int, int] = {}
_next_due_override_by_user: dict[int, datetime] = {}

# Rolling process-lifetime counters for sync efficiency tracking.
_sync_efficiency_counters: dict[str, int] = {
    "changes": 0,
    "no_changes": 0,
}
last_rollup_persisted_at = None


def _verbose_sync_console() -> bool:
    return str(os.getenv("SYNC_CONSOLE_VERBOSE", "0")).strip().lower() in {"1", "true", "yes", "on"}


def _truthy_env(name: str, default: bool) -> bool:
    """Resolve boolean environment flags with a single parser."""
    raw = os.getenv(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def _adaptive_backoff_enabled() -> bool:
    """Kill switch for adaptive no-change backoff."""
    return _truthy_env("SYNC_ADAPTIVE_BACKOFF_ENABLED", True)


def _adaptive_backoff_max_minutes() -> int:
    """Upper bound for adaptive next-run delay when no changes are detected."""
    try:
        return max(5, int(os.getenv("SYNC_ADAPTIVE_BACKOFF_MAX_MINUTES", "60")))
    except ValueError:
        return 60


def _scheduler_heartbeat_minutes() -> int:
    """How often the scheduler wakes up to evaluate per-user due state."""
    try:
        return max(1, int(os.getenv("SYNC_SCHEDULER_HEARTBEAT_MINUTES", str(DEFAULT_SYNC_HEARTBEAT_MINUTES))))
    except ValueError:
        return DEFAULT_SYNC_HEARTBEAT_MINUTES


def _apple_min_sync_minutes() -> int:
    """Provider floor for Apple/CalDAV polling cadence."""
    try:
        return max(15, int(os.getenv("SYNC_APPLE_MIN_FREQUENCY_MINUTES", str(DEFAULT_APPLE_MIN_SYNC_MINUTES))))
    except ValueError:
        return DEFAULT_APPLE_MIN_SYNC_MINUTES


def _sync_operation_max_attempts() -> int:
    """How many failed attempts are allowed before dead-lettering a sync stream."""
    try:
        return max(1, int(os.getenv("SYNC_OPERATION_MAX_ATTEMPTS", "3")))
    except ValueError:
        return 3


def _scheduler_owner() -> str:
    """Configured scheduler owner role for exclusive execution."""
    return str(os.getenv("SYNC_SCHEDULER_OWNER", "render")).strip().lower() or "render"


def _scheduler_execution_enabled() -> bool:
    """Whether this process should execute scheduler jobs."""
    return _scheduler_owner() == "render"


def _normalized_provider(account) -> str:
    return str(getattr(account, "provider", "") or "").strip().lower()


def _effective_account_sync_minutes(account) -> int:
    """
    Compute provider-aware cadence.

    Apple/CalDAV should not churn at 5-minute intervals by default because it
    has no upstream delta token and each poll is usually a full-window scan.
    """
    configured = int(getattr(account, "sync_frequency_minutes", 5) or 5)
    configured = max(1, configured)

    if _normalized_provider(account) == "apple":
        return max(configured, _apple_min_sync_minutes())

    return configured


def _compute_sync_window_days(accounts) -> int:
    """Use per-account sync_range_days and clamp to a safe production window."""
    configured_days = [
        int(getattr(account, "sync_range_days", 30) or 30)
        for account in accounts
    ]
    return max(1, min(max(configured_days) if configured_days else 30, 365))


def _build_sync_window(window_days: int, now: datetime):
    """Construct the exact start/end window passed into calendar_service.sync_all."""
    return now - timedelta(days=window_days), now + timedelta(days=window_days)


def _sync_result_has_changes(sync_result: dict | None) -> bool:
    """Treat create/update/delete/dedup activity as material sync change."""
    if not isinstance(sync_result, dict):
        return True

    created = int(sync_result.get("created") or 0)
    updated = int(sync_result.get("updated") or 0)
    deleted = int(sync_result.get("deleted") or 0)
    deduped = int(sync_result.get("deduped") or 0)
    return (created + updated + deleted + deduped) > 0


def _record_sync_efficiency(had_changes: bool) -> None:
    """Track how often sync cycles produce data changes versus no-ops."""
    if had_changes:
        _sync_efficiency_counters["changes"] = int(_sync_efficiency_counters.get("changes", 0)) + 1
    else:
        _sync_efficiency_counters["no_changes"] = int(_sync_efficiency_counters.get("no_changes", 0)) + 1


def _collect_efficiency_snapshot() -> dict:
    """Collect current in-memory scheduler and Google cache metrics."""
    from app.services.google_calendar_service import GoogleCalendarService

    changes = int(_sync_efficiency_counters.get("changes", 0))
    no_changes = int(_sync_efficiency_counters.get("no_changes", 0))
    total_cycles = changes + no_changes
    cache = GoogleCalendarService.get_calendar_list_cache_metrics()

    return {
        "changes": changes,
        "no_changes": no_changes,
        "total_cycles": total_cycles,
        "change_ratio": (changes / total_cycles) if total_cycles else None,
        "no_change_ratio": (no_changes / total_cycles) if total_cycles else None,
        "google_cache_hits": int(cache.get("hits") or 0),
        "google_cache_misses": int(cache.get("misses") or 0),
        "google_cache_total_lookups": int(cache.get("total_lookups") or 0),
        "google_cache_hit_ratio": cache.get("hit_ratio"),
        "google_cache_entries": int(cache.get("cache_entries") or 0),
    }


def persist_sync_efficiency_rollup() -> None:
    """
    Persist daily sync-efficiency rollup snapshots for week-over-week analysis.

    This runs as a lightweight scheduler task and writes one row per UTC day,
    upserting the latest counters for that day.
    """

    global last_rollup_persisted_at

    now = datetime.now(timezone.utc)
    snapshot_date = now.date()
    week_start_date = snapshot_date - timedelta(days=snapshot_date.weekday())
    snapshot = _collect_efficiency_snapshot()

    db = SessionLocal()
    operation_key = _rollup_operation_key(snapshot_date)
    if is_operation_dead_letter(db, operation_key=operation_key):
        logger.warning("[SYNC] rollup skipped: dead-letter operation key %s", operation_key)
        db.close()
        return
    operation_id = begin_sync_operation(
        db,
        operation_key=operation_key,
        owner_user_id=None,
        operation_type=SYNC_ROLLUP_OPERATION_TYPE,
        request_payload={
            "snapshot_date": snapshot_date.isoformat(),
            "week_start_date": week_start_date.isoformat(),
        },
    )
    try:
        row = (
            db.query(SyncEfficiencyDailyRollup)
            .filter(SyncEfficiencyDailyRollup.snapshot_date == snapshot_date)
            .first()
        )

        if row is None:
            row = SyncEfficiencyDailyRollup(
                snapshot_date=snapshot_date,
                week_start_date=week_start_date,
            )
            db.add(row)

        row.week_start_date = week_start_date
        row.changes = snapshot["changes"]
        row.no_changes = snapshot["no_changes"]
        row.total_cycles = snapshot["total_cycles"]
        row.change_ratio = snapshot["change_ratio"]
        row.no_change_ratio = snapshot["no_change_ratio"]
        row.google_cache_hits = snapshot["google_cache_hits"]
        row.google_cache_misses = snapshot["google_cache_misses"]
        row.google_cache_total_lookups = snapshot["google_cache_total_lookups"]
        row.google_cache_hit_ratio = snapshot["google_cache_hit_ratio"]
        row.google_cache_entries = snapshot["google_cache_entries"]
        row.updated_at = now

        db.commit()
        complete_sync_operation(
            db,
            operation_id=operation_id,
            status="succeeded",
            result_payload={
                "snapshot_date": snapshot_date.isoformat(),
                "total_cycles": snapshot["total_cycles"],
            },
        )
        last_rollup_persisted_at = now
        logger.info("[SYNC] daily rollup persisted for %s", snapshot_date.isoformat())
    except Exception as exc:
        db.rollback()
        complete_sync_operation(
            db,
            operation_id=operation_id,
            status="failed",
            error=exc,
            max_attempts=_sync_operation_max_attempts(),
        )
        logger.warning("[SYNC] daily rollup persist failed: %s", exc)
    finally:
        db.close()

def _latest_account_sync_marker(account):
    candidates = [
        getattr(account, "last_sync", None),
        getattr(account, "last_sync_success", None),
        getattr(account, "last_manual_refresh_at", None),
    ]
    best = max((value for value in candidates if value is not None), default=None)
    if best is not None and getattr(best, "tzinfo", None) is None:
        # DB returns naive datetimes stored in UTC — make them aware for comparison
        best = best.replace(tzinfo=timezone.utc)
    return best


def _is_reauth_required(account):
    return (getattr(account, "access_token", "") or "").strip() == "__REAUTH_REQUIRED__"


def _register_sync_outcome(user_id: int, accounts, had_changes: bool, now: datetime) -> None:
    """
    Update adaptive throttling state from the latest sync outcome.

    Behavior:
    - Changes detected: clear backoff immediately.
    - No changes: exponentially back off up to SYNC_ADAPTIVE_BACKOFF_MAX_MINUTES.
    """
    if not _adaptive_backoff_enabled() or not accounts:
        _no_change_streak_by_user.pop(user_id, None)
        _next_due_override_by_user.pop(user_id, None)
        _record_sync_efficiency(had_changes)
        return

    base_cadence = min(_effective_account_sync_minutes(a) for a in accounts)

    if had_changes:
        _no_change_streak_by_user[user_id] = 0
        _next_due_override_by_user.pop(user_id, None)
        _record_sync_efficiency(True)
        return

    streak = int(_no_change_streak_by_user.get(user_id, 0)) + 1
    _no_change_streak_by_user[user_id] = streak

    multiplier = 2 ** min(streak, 6)
    backoff_minutes = base_cadence * multiplier
    backoff_minutes = min(backoff_minutes, max(base_cadence, _adaptive_backoff_max_minutes()))

    _next_due_override_by_user[user_id] = now + timedelta(minutes=backoff_minutes)
    _record_sync_efficiency(False)
    logger.debug(
        "[SYNC] user=%s no-change streak=%s adaptive-backoff=%s min",
        user_id,
        streak,
        backoff_minutes,
    )


def _is_user_sync_due(user_id: int, accounts, now):
    if not accounts:
        return False, None

    cadence = min(_effective_account_sync_minutes(account) for account in accounts)

    if _adaptive_backoff_enabled():
        override_due = _next_due_override_by_user.get(user_id)
        if override_due and now < override_due:
            return False, cadence

    latest_marker = max((_latest_account_sync_marker(account) for account in accounts), default=None)

    if latest_marker is None:
        return True, cadence

    return now >= (latest_marker + timedelta(minutes=cadence)), cadence


def _sync_operation_key(user_id: int, accounts) -> str:
    """Deterministic per-user operation key that remains stable across retries."""
    latest_marker = max((_latest_account_sync_marker(account) for account in accounts), default=None)
    anchor = "bootstrap"
    if latest_marker is not None:
        anchor = str(int(latest_marker.astimezone(timezone.utc).timestamp()))
    return f"scheduler-sync:user:{user_id}:anchor:{anchor}"


def _rollup_operation_key(snapshot_date) -> str:
    return f"scheduler-rollup:date:{snapshot_date.isoformat()}"


def _diag_prune_operation_key(cutoff: datetime) -> str:
    return f"scheduler-tv-diag-prune:cutoff:{cutoff.date().isoformat()}"


def _operation_ledger_volume_summary(window_hours: int = 24) -> dict:
    """Return compact operation-ledger volume metrics for migration evidence."""
    db = SessionLocal()
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(hours=max(1, int(window_hours)))
    try:
        total_operations = int(db.query(func.count(SyncOperationLedger.id)).scalar() or 0)
        created_last_window = int(
            db.query(func.count(SyncOperationLedger.id))
            .filter(SyncOperationLedger.created_at >= window_start)
            .scalar()
            or 0
        )

        by_status = {
            str(status): int(count)
            for status, count in (
                db.query(SyncOperationLedger.status, func.count(SyncOperationLedger.id))
                .filter(SyncOperationLedger.created_at >= window_start)
                .group_by(SyncOperationLedger.status)
                .all()
            )
        }

        by_operation_type = {
            str(operation_type): int(count)
            for operation_type, count in (
                db.query(SyncOperationLedger.operation_type, func.count(SyncOperationLedger.id))
                .filter(SyncOperationLedger.created_at >= window_start)
                .group_by(SyncOperationLedger.operation_type)
                .all()
            )
        }

        return {
            "available": True,
            "window_hours": int(window_hours),
            "window_started_at": window_start.isoformat(),
            "captured_at": now.isoformat(),
            "total_operations": total_operations,
            "created_in_window": created_last_window,
            "by_status": by_status,
            "by_operation_type": by_operation_type,
        }
    except Exception as exc:
        logger.warning("[SCHEDULER] operation-ledger summary unavailable: %s", exc)
        return {
            "available": False,
            "window_hours": int(window_hours),
            "window_started_at": window_start.isoformat(),
            "captured_at": now.isoformat(),
            "error_type": type(exc).__name__,
        }
    finally:
        db.close()


# ==================================================
# MAIN SYNC FUNCTION
# ==================================================

def run_event_sync():
    """
    This is the job that runs in the background.
    
    What it does:
    1. Opens database connection
    2. Gets ALL users
    3. Syncs each user one-by-one
    4. Closes database
    
    This prevents:
    - mixing user data
    - missing events
    """

    global last_global_sync_started_at, last_global_sync_finished_at, last_global_sync_error

    db = SessionLocal()
    verbose = _verbose_sync_console()
    last_global_sync_started_at = datetime.now(timezone.utc)
    last_global_sync_error = None

    synced = skipped = failed = 0

    try:
        # Only users that actually have a sync-enabled account can be due, so
        # the wakeup costs one join instead of a query per registered user.
        users = (
            db.query(User)
            .join(OAuthAccount, OAuthAccount.user_id == User.id)
            .filter(
                OAuthAccount.sync_enabled == True,
                OAuthAccount.access_token != "__REAUTH_REQUIRED__",
            )
            .distinct()
            .all()
        )

        if not users:
            return

        for user in users:
            operation_id = None
            try:
                user_accounts = db.query(OAuthAccount).filter(
                    OAuthAccount.user_id == user.id,
                    OAuthAccount.sync_enabled == True,
                    OAuthAccount.access_token != "__REAUTH_REQUIRED__",
                ).all()
                user_accounts = [
                    account for account in user_accounts
                    if not _is_reauth_required(account)
                ]

                now_for_user = datetime.now(timezone.utc)
                due, cadence = _is_user_sync_due(user.id, user_accounts, now_for_user)
                if not due:
                    skipped += 1
                    logger.debug("[SYNC] user=%s skipped, cadence %s min not due", user.id, cadence)
                    continue

                operation_key = _sync_operation_key(user.id, user_accounts)
                if is_operation_dead_letter(db, operation_key=operation_key):
                    skipped += 1
                    logger.warning("[SYNC] user=%s skipped: dead-letter operation key", user.id)
                    continue

                operation_id = begin_sync_operation(
                    db,
                    operation_key=operation_key,
                    owner_user_id=user.id,
                    request_payload={
                        "cadence_minutes": cadence,
                    },
                )

                # Keep scheduler behavior aligned with manual sync: use per-account
                # sync_range_days rather than CalendarService default range.
                window_days = _compute_sync_window_days(user_accounts)
                start_date, end_date = _build_sync_window(window_days, now_for_user)

                # ✅ THIS IS THE FIX (was sync_events before)
                if verbose:
                    result = calendar_service.sync_all(
                        db,
                        user,
                        start_date=start_date,
                        end_date=end_date,
                    )
                    logger.info("[SYNC] user=%s %s", user.id, result)
                else:
                    # Quiet mode: suppress noisy provider sync print spam.
                    with redirect_stdout(io.StringIO()):
                        result = calendar_service.sync_all(
                            db,
                            user,
                            start_date=start_date,
                            end_date=end_date,
                        )

                _register_sync_outcome(
                    user_id=user.id,
                    accounts=user_accounts,
                    had_changes=_sync_result_has_changes(result),
                    now=datetime.now(timezone.utc),
                )

                complete_sync_operation(
                    db,
                    operation_id=operation_id,
                    status="succeeded",
                    result_payload={
                        "window_days": window_days,
                        "had_changes": _sync_result_has_changes(result),
                    },
                )
                synced += 1

            except Exception as user_error:
                complete_sync_operation(
                    db,
                    operation_id=operation_id,
                    status="failed",
                    error=user_error,
                    max_attempts=_sync_operation_max_attempts(),
                )
                failed += 1
                logger.error("[SYNC] user=%s FAILED: %s", user.id, user_error)

        # One line per cycle instead of one per user; only when something ran.
        if synced or failed:
            logger.info("[SYNC] cycle complete synced=%s skipped=%s failed=%s", synced, skipped, failed)
        else:
            logger.debug("[SYNC] cycle complete, nothing due (skipped=%s)", skipped)

    except Exception as e:
        last_global_sync_error = str(e)
        logger.error("[SYNC] Global Failure: %s", e)

    finally:
        last_global_sync_finished_at = datetime.now(timezone.utc)
        db.close()


# ==================================================
# TV DIAGNOSTICS RETENTION
# ==================================================

def _diag_retention_days() -> int:
    try:
        return max(1, int(os.getenv("TV_DIAG_RETENTION_DAYS", "14")))
    except ValueError:
        return 14


def prune_tv_diag_log():
    """
    Bound tv_diag_log. It is the only table that grows without user action —
    a kiosk beacons around the clock — so without this it fills the database
    quota on its own.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=_diag_retention_days())
    db = SessionLocal()
    operation_key = _diag_prune_operation_key(cutoff)
    if is_operation_dead_letter(db, operation_key=operation_key):
        logger.warning("[DIAG] prune skipped: dead-letter operation key %s", operation_key)
        db.close()
        return
    operation_id = begin_sync_operation(
        db,
        operation_key=operation_key,
        owner_user_id=None,
        operation_type=SYNC_TV_DIAG_PRUNE_OPERATION_TYPE,
        request_payload={
            "cutoff": cutoff.isoformat(),
            "retention_days": _diag_retention_days(),
        },
    )
    try:
        deleted = (
            db.query(TVDiagLog)
            .filter(TVDiagLog.ts_server < cutoff)
            .delete(synchronize_session=False)
        )
        db.commit()
        complete_sync_operation(
            db,
            operation_id=operation_id,
            status="succeeded",
            result_payload={
                "deleted_rows": int(deleted or 0),
                "cutoff_date": cutoff.date().isoformat(),
            },
        )
        if deleted:
            logger.info("[DIAG] pruned %s tv_diag_log rows older than %s", deleted, cutoff.date())
    except Exception as exc:
        db.rollback()
        complete_sync_operation(
            db,
            operation_id=operation_id,
            status="failed",
            error=exc,
            max_attempts=_sync_operation_max_attempts(),
        )
        logger.warning("[DIAG] tv_diag_log prune failed: %s", exc)
    finally:
        db.close()


# ==================================================
# START SCHEDULER
# ==================================================

def start_scheduler():
    """
    Starts the background scheduler
    
    Wakes on a short heartbeat and only syncs users/accounts that are due.
    """

    if not _scheduler_execution_enabled():
        logger.info(
            "[SCHEDULER] startup skipped (owner=%s, expected=render)",
            _scheduler_owner(),
        )
        return

    heartbeat_minutes = _scheduler_heartbeat_minutes()

    scheduler.add_job(
        run_event_sync,
        "interval",
        minutes=heartbeat_minutes,
        id="event_sync_job",
        replace_existing=True
    )

    scheduler.add_job(
        prune_tv_diag_log,
        "interval",
        hours=24,
        id="tv_diag_prune_job",
        replace_existing=True
    )

    scheduler.add_job(
        persist_sync_efficiency_rollup,
        "cron",
        hour=0,
        minute=5,
        id="sync_efficiency_rollup_job",
        replace_existing=True,
    )

    scheduler.start()

    logger.info(
        "[SCHEDULER] Background sync started (heartbeat=%s min, apple_min=%s min); diag prune daily; sync rollup daily",
        heartbeat_minutes,
        _apple_min_sync_minutes(),
    )


def get_scheduler_health(user_id: int | None = None):
    """
    Return scheduler runtime health plus sync efficiency observability.

    Optional user_id enables per-user adaptive backoff visibility without
    exposing other users' state.
    """
    from app.services.google_calendar_service import GoogleCalendarService

    next_run = None
    try:
        job = scheduler.get_job("event_sync_job")
        next_run = job.next_run_time.isoformat() if job and job.next_run_time else None
    except Exception:
        next_run = None

    changes = int(_sync_efficiency_counters.get("changes", 0))
    no_changes = int(_sync_efficiency_counters.get("no_changes", 0))
    total_cycles = changes + no_changes

    calendar_cache_metrics = GoogleCalendarService.get_calendar_list_cache_metrics()

    adaptive_summary = {
        "enabled": _adaptive_backoff_enabled(),
        "max_minutes": _adaptive_backoff_max_minutes(),
        "tracked_users": len(_no_change_streak_by_user),
        "users_in_backoff": len(_next_due_override_by_user),
        "last_rollup_persisted_at": last_rollup_persisted_at.isoformat() if last_rollup_persisted_at else None,
    }

    adaptive_user = None
    if user_id is not None:
        next_due = _next_due_override_by_user.get(user_id)
        adaptive_user = {
            "user_id": user_id,
            "no_change_streak": int(_no_change_streak_by_user.get(user_id, 0)),
            "backoff_active": bool(next_due and datetime.now(timezone.utc) < next_due),
            "next_due_override_at": next_due.isoformat() if next_due else None,
        }

    operation_ledger = _operation_ledger_volume_summary(window_hours=24)

    return {
        "running": scheduler.running,
        "owner": _scheduler_owner(),
        "execution_enabled": _scheduler_execution_enabled(),
        "last_started_at": last_global_sync_started_at.isoformat() if last_global_sync_started_at else None,
        "last_finished_at": last_global_sync_finished_at.isoformat() if last_global_sync_finished_at else None,
        "last_error": last_global_sync_error,
        "next_run_at": next_run,
        "frequency_minutes": _scheduler_heartbeat_minutes(),
        "apple_min_frequency_minutes": _apple_min_sync_minutes(),
        "adaptive_backoff": adaptive_summary,
        "adaptive_backoff_user": adaptive_user,
        "operation_ledger": operation_ledger,
        "efficiency": {
            "changes": changes,
            "no_changes": no_changes,
            "total_cycles": total_cycles,
            "change_ratio": (changes / total_cycles) if total_cycles else None,
            "no_change_ratio": (no_changes / total_cycles) if total_cycles else None,
        },
        "google_calendar_list_cache": calendar_cache_metrics,
    }
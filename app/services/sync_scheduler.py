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
from app.database import SessionLocal
from app.services.calendar_service import CalendarService
from app.models import User, OAuthAccount, TVDiagLog   # ✅ VERY IMPORTANT (we loop users)
from datetime import datetime, timezone
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


def _verbose_sync_console() -> bool:
    return str(os.getenv("SYNC_CONSOLE_VERBOSE", "0")).strip().lower() in {"1", "true", "yes", "on"}

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


def _is_user_sync_due(accounts, now):
    if not accounts:
        return False, None

    cadence = min(max(int(getattr(account, "sync_frequency_minutes", 5) or 5), 1) for account in accounts)
    latest_marker = max((_latest_account_sync_marker(account) for account in accounts), default=None)

    if latest_marker is None:
        return True, cadence

    return now >= (latest_marker + timedelta(minutes=cadence)), cadence


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
            .filter(OAuthAccount.sync_enabled == True)
            .distinct()
            .all()
        )

        if not users:
            return

        for user in users:
            try:
                user_accounts = db.query(OAuthAccount).filter(
                    OAuthAccount.user_id == user.id,
                    OAuthAccount.sync_enabled == True
                ).all()

                due, cadence = _is_user_sync_due(user_accounts, datetime.now(timezone.utc))
                if not due:
                    skipped += 1
                    logger.debug("[SYNC] user=%s skipped, cadence %s min not due", user.id, cadence)
                    continue

                # ✅ THIS IS THE FIX (was sync_events before)
                if verbose:
                    result = calendar_service.sync_all(db, user)
                    logger.info("[SYNC] user=%s %s", user.id, result)
                else:
                    # Quiet mode: suppress noisy provider sync print spam.
                    with redirect_stdout(io.StringIO()):
                        calendar_service.sync_all(db, user)
                synced += 1

            except Exception as user_error:
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
    try:
        deleted = (
            db.query(TVDiagLog)
            .filter(TVDiagLog.ts_server < cutoff)
            .delete(synchronize_session=False)
        )
        db.commit()
        if deleted:
            logger.info("[DIAG] pruned %s tv_diag_log rows older than %s", deleted, cutoff.date())
    except Exception as exc:
        db.rollback()
        logger.warning("[DIAG] tv_diag_log prune failed: %s", exc)
    finally:
        db.close()


# ==================================================
# START SCHEDULER
# ==================================================

def start_scheduler():
    """
    Starts the background scheduler
    
    Runs every 5 minutes (change below if needed)
    """

    scheduler.add_job(
        run_event_sync,
        "interval",
        minutes=5,   # ✅ You can change this (e.g., 1 for faster testing)
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

    scheduler.start()

    logger.info("[SCHEDULER] Background sync started (every 5 min); diag prune daily")


def get_scheduler_health():
    next_run = None
    try:
        job = scheduler.get_job("event_sync_job")
        next_run = job.next_run_time.isoformat() if job and job.next_run_time else None
    except Exception:
        next_run = None

    return {
        "running": scheduler.running,
        "last_started_at": last_global_sync_started_at.isoformat() if last_global_sync_started_at else None,
        "last_finished_at": last_global_sync_finished_at.isoformat() if last_global_sync_finished_at else None,
        "last_error": last_global_sync_error,
        "next_run_at": next_run,
        "frequency_minutes": 5,
    }
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

from apscheduler.schedulers.background import BackgroundScheduler
from contextlib import redirect_stdout
import io
import os
from app.database import SessionLocal
from app.services.calendar_service import CalendarService
from app.models import User, OAuthAccount   # ✅ VERY IMPORTANT (we loop users)
from datetime import datetime, timezone
from datetime import datetime, timezone, timedelta


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
    return max((value for value in candidates if value is not None), default=None)


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

    try:
        # ✅ STEP 1: Get all users
        users = db.query(User).all()

        if not users:
            if verbose:
                print("[SYNC] No users found")
            return

        # ✅ STEP 2: Loop each user
        for user in users:
            try:
                user_accounts = db.query(OAuthAccount).filter(
                    OAuthAccount.user_id == user.id,
                    OAuthAccount.sync_enabled == True
                ).all()

                if not user_accounts:
                    continue

                due, cadence = _is_user_sync_due(user_accounts, datetime.now(timezone.utc))
                if not due:
                    if verbose:
                        print(f"[SYNC] User {user.id}: skipped (cadence {cadence} min not due yet)")
                    continue

                # ✅ THIS IS THE FIX (was sync_events before)
                if verbose:
                    result = calendar_service.sync_all(db, user)
                    print(f"[SYNC] User {user.id}: {result}")
                else:
                    # Quiet mode: suppress noisy provider sync print spam.
                    with redirect_stdout(io.StringIO()):
                        calendar_service.sync_all(db, user)

            except Exception as user_error:
                print(f"[SYNC] User {user.id} FAILED: {user_error}")

    except Exception as e:
        last_global_sync_error = str(e)
        print(f"[SYNC] Global Failure: {e}")

    finally:
        last_global_sync_finished_at = datetime.now(timezone.utc)
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

    scheduler.start()

    if _verbose_sync_console():
        print("[SCHEDULER] Background sync started (every 5 min)")


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
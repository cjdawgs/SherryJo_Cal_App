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
from app.database import SessionLocal
from app.services.calendar_service import CalendarService
from app.models import User   # ✅ VERY IMPORTANT (we loop users)


# ==================================================
# SETUP
# ==================================================

scheduler = BackgroundScheduler()
calendar_service = CalendarService()


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

    db = SessionLocal()

    try:
        # ✅ STEP 1: Get all users
        users = db.query(User).all()

        if not users:
            print("[SYNC] No users found")
            return

        # ✅ STEP 2: Loop each user
        for user in users:
            try:
                # ✅ THIS IS THE FIX (was sync_events before)
                result = calendar_service.sync_all(db, user)

                print(f"[SYNC] User {user.id}: {result}")

            except Exception as user_error:
                print(f"[SYNC] User {user.id} FAILED: {user_error}")

    except Exception as e:
        print(f"[SYNC] Global Failure: {e}")

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

    scheduler.start()

    print("[SCHEDULER] Background sync started (every 5 min)")
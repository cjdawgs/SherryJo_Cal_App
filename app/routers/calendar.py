
# ==================================================
# IMPORTS
# ==================================================
from sqlalchemy import func   # ✅ add this import at top if not already there
import os

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session
from datetime import datetime, timedelta, timezone

from app.database import get_db
from app.models import Event, Note, OAuthAccount
from app.deps import get_current_user

from app.services.calendar_service import CalendarService, normalize_provider
from app.services.multi_account_oauth_service import (
    MultiAccountOAuthService,
    ensure_valid_token,
    resolve_account_status
)



print("✅ CALENDAR ROUTER FILE LOADED")

router = APIRouter(prefix="/calendar", tags=["calendar"])

calendar_service = CalendarService()

# ==================================================
# ✅ SAFE HELPERS (TOP LEVEL — NOT INSIDE ANY FUNCTION)
# ==================================================


def to_dt(val):
    if not val:
        return None

    if isinstance(val, datetime):
        return val if val.tzinfo else val.replace(tzinfo=timezone.utc)

    if isinstance(val, str):
        try:
            dt = datetime.fromisoformat(val.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except:
            return None

    return None


def to_iso(val):
    if not val:
        return None
    return val if isinstance(val, str) else val.isoformat()




# ==================================================
# ✅ DEBUG ROUTE — DB COUNT BY USER (TEMP)
# ==================================================

@router.get("/debug/db-count")
def debug_db_count(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):
    try:
        total = db.query(Event).count()

        by_user = (
            db.query(Event.owner_id, func.count())
            .group_by(Event.owner_id)
            .all()
        )

        print("🧪 TOTAL EVENTS IN DB:", total)
        print("🧪 EVENTS BY USER:", by_user)

        return {
            "total": total,
            "by_user": by_user
        }

    except Exception as e:
        print("❌ DEBUG ROUTE ERROR:", str(e))
        return {
            "error": str(e)
        }
        
@router.post("/debug/wipe-user-events")
def wipe_user_events(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):
    deleted = db.query(Event).filter(
        Event.owner_id == current_user.id
    ).delete(synchronize_session=False)

    db.commit()

    remaining = db.query(Event).count()

    print("🔥 DELETED ROWS:", deleted)
    print("🧪 TOTAL AFTER WIPE:", remaining)

    return {
        "deleted": deleted,
        "remaining": remaining
    }

# ==================================================
# ✅ Post Event (SEPARATE FUNCTION)
# ==================================================
@router.post("/event")
async def create_event(
    request: Request,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_user)
):
    data = await request.json()

    title = data.get("title")
    start_time = to_dt(data.get("start_time"))
    end_time = to_dt(data.get("end_time"))  

    event = Event(
        title=title,
        start_time=start_time,
        end_time=end_time,
        owner_id=current_user.id
    )

    db.add(event)
    db.commit()
    db.refresh(event)

    return {"status": "ok", "event_id": event.id}

# ==================================================
# ✅ SYNC ENDPOINT (SEPARATE FUNCTION)
# ==================================================

@router.post("/sync")
def sync_calendar(
    db: Session = Depends(get_db),
    current_user = Depends(get_current_user)
):
    """
    ✅ Phase 3: FULL SYNC (DB hydration)
    - Calls sync_all()
    - Populates DB from external providers
    - No per-account loops
    """

    print("🔥 FULL SYNC TRIGGERED")
   
    db_url = str(getattr(db.bind, "url", "UNKNOWN"))
    print("🧪 [SYNC] DB FILE:", db_url)

    print("🧪 [SYNC] WORKING DIR:", os.getcwd())
    print("🧪 [SYNC] DB COUNT AT START:", db.query(Event).count())

    try:
        result = calendar_service.sync_all(db, current_user)

        print("🔥 SYNC RESULT:", result)

        return {
            "status": "success",
            "result": result
        }

    except Exception as e:
        print("❌ SYNC FAILED:", str(e))

        return {
            "status": "error",
            "message": str(e)
        }

# ==================================================
# ✅ UNIFIED CALENDAR (FINAL CLEAN VERSION)
# ==================================================

@router.get("/unified")
def get_unified_calendar(
    range_days: int = Query(30),
    start: str = Query(None),
    end: str = Query(None),

    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):

    now = datetime.now(timezone.utc)
    
    db_url = str(getattr(db.bind, "url", "UNKNOWN"))
    print("🧪 [SYNC] DB FILE:", db_url)

    print("🧪 [UNIFIED] WORKING DIR:", os.getcwd())
    print("🧪 [UNIFIED] DB ROW COUNT:", db.query(Event).count())
    

    # ==================================================
    # ✅ NEW: SUPPORT FULLCALENDAR RANGE
    # ==================================================
    if start and end:
        try:
            start_date = datetime.fromisoformat(start).astimezone(timezone.utc)
            end_date = datetime.fromisoformat(end).astimezone(timezone.utc)

            print(f"✅ FULLCAL RANGE: {start_date} → {end_date}")

        except Exception as e:
            print("❌ Invalid start/end, falling back:", e)

            start_date = now - timedelta(days=range_days)
            end_date = now + timedelta(days=range_days)

    else:
        start_date = now - timedelta(days=range_days)
        end_date = now + timedelta(days=range_days)

        print(f"✅ RANGE WINDOW: ±{range_days} days")


    # ------------------------------------------
    # ✅ NEW FAST READ PATH (PHASE 3.2)
    # ------------------------------------------
    # ✅ FAST READ PATH
    events = calendar_service.get_events_from_db(
        db,
        current_user,
        start_date,
        end_date
    )

    account_event_totals = {}
    for ev in events:
        key = ev.get("account_key")
        if not key:
            continue
        account_event_totals[key] = account_event_totals.get(key, 0) + 1

    print(f"⚡ FAST DB EVENTS: {len(events)}")

    # ✅ ACCOUNT STATUS
    accounts = MultiAccountOAuthService.get_user_accounts(
        db, current_user.id
    )

    account_status = {}

    for acc in accounts:
        provider = normalize_provider(acc.provider)

        key = f"{provider}:{(acc.account_email or '').lower().strip()}"

        account_status[key] = resolve_account_status(acc)

    return {
        "events": events,
        "account_status": account_status,
        "account_event_totals": account_event_totals
    }
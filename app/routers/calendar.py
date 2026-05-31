
# ==================================================
# IMPORTS
# ==================================================

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.orm import Session
from datetime import datetime, timedelta, timezone

from app.database import get_db
from app.models import Event, Note
from app.deps import get_current_user

from app.services.calendar_service import CalendarService
from app.services.event_actions import EventActions
from app.services.google_calendar_service import GoogleCalendarService
from app.services.graph_client import GraphClient
from app.services.multi_account_oauth_service import MultiAccountOAuthService


print("✅ CALENDAR ROUTER FILE LOADED")


router = APIRouter(prefix="/calendar", tags=["calendar"])

calendar_service = CalendarService()
event_actions = EventActions()
google_service = GoogleCalendarService()
graph_client = GraphClient()


# ==================================================
# ✅ SAFE HELPERS (HARDENED)
# ==================================================

def to_dt(val):
    """
    ✅ GUARANTEE:
    Always return UTC-aware datetime or None
    """

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
# GET CALENDAR (UNCHANGED)
# ==================================================

@router.get("/")
def get_calendar(date: str = Query(...), db: Session = Depends(get_db)):

    selected_date = datetime.fromisoformat(date)

    start_of_day = datetime(
        selected_date.year,
        selected_date.month,
        selected_date.day
    )
    end_of_day = start_of_day + timedelta(days=1)

    events = db.query(Event).filter(
        Event.start_time >= start_of_day,
        Event.start_time < end_of_day
    ).all()

    formatted_events = [{
        "id": str(e.id),
        "title": e.title,
        "start": to_iso(e.start_time),
        "end": to_iso(e.end_time),
        "extendedProps": {
            "description": e.description or "",
            "status": getattr(e, "status", "pending"),
            "source": getattr(e, "source", "local")
        }
    } for e in events]

    notes = db.query(Note).filter(Note.date == date).all()

    formatted_notes = [{
        "id": n.id,
        "content": n.content,
        "event_id": n.event_id,
        "color": n.color
    } for n in notes]

    return {
        "events": formatted_events,
        "tasks": [],
        "notes": formatted_notes
    }


# ==================================================
# ✅ MANUAL SYNC (UNCHANGED)
# ==================================================

@router.post("/sync")
def manual_sync(
    db: Session = Depends(get_db),
    current_user = Depends(get_current_user)
):
    result = calendar_service.sync_all(db, current_user)

    return {
        "message": "Sync completed ✅",
        "user_id": current_user.id,
        "result": result
    }


# ==================================================
# ✅ UNIFIED CALENDAR (FINAL FIXED)
# ==================================================
@router.get("/unified")
def get_unified_calendar(
    range_days: int = Query(30),  # ✅ DEFAULT = Monthly (FAST)
    db: Session = Depends(get_db),
    current_user = Depends(get_current_user)
):
    """
    ✅ RANGE SYSTEM (NEW)
    
    Controls how much data we pull:
    - 30  = Monthly (default)
    - 90  = Quarterly
    - 180 = Semi-Annual
    - 360 = Yearly
    """

    now = datetime.utcnow()

    start_date = now - timedelta(days=range_days)
    end_date = now + timedelta(days=range_days)

    print(f"✅ RANGE WINDOW: ±{range_days} days")

    # ------------------------------------------
    # STEP 1: FETCH EXTERNAL EVENTS
    # ------------------------------------------
    try:
        # ✅ RANGE-AWARE FETCH (NEW)
        events = calendar_service.fetch_all_events(
            db,
            current_user,
            start_date=start_date,
            end_date=end_date
        )

    except Exception as e:
        print(f"❌ fetch_all_events failed: {e}")
        events = []

    print(f"✅ External events fetched: {len(events)}")

    # ✅ Normalize external events
    for e in events:
        e["_start_dt"] = to_dt(e.get("start"))
        e["_end_dt"] = to_dt(e.get("end"))

    # ------------------------------------------
    # STEP 2: ADD LOCAL EVENTS
    # ------------------------------------------
    now = datetime.now(timezone.utc)
    db_events = db.query(Event).filter(
        Event.owner_id == current_user.id,
        Event.end_time >= start_date,
        Event.start_time <= end_date
    ).all()

    for e in db_events:
        events.append({
            "id": e.id,
            "external_id": e.externalId,
            "title": e.title,
            "start": to_iso(e.start_time),
            "end": to_iso(e.end_time),
            "source": "local",
            "account": "local",
            "color": "#666666",
            "conflict": False,

            # ✅ CRITICAL FIX: normalize DB datetimes too
            "_start_dt": to_dt(e.start_time),
            "_end_dt": to_dt(e.end_time)
        })

    # ------------------------------------------
    # STEP 3: SORT (FULLY SAFE)
    # ------------------------------------------
    FAR_FUTURE = datetime(9999, 1, 1, tzinfo=timezone.utc)

    def sort_key(e):
        return e.get("_start_dt") or FAR_FUTURE

    events.sort(key=sort_key)

    # ------------------------------------------
    # STEP 4: CONFLICT DETECTION (SAFE)
    # ------------------------------------------
    for i in range(len(events)):
        events[i]["conflict"] = False

        for j in range(len(events)):
            if i == j:
                continue

            s1 = events[i].get("_start_dt")
            e1_end = events[i].get("_end_dt")
            s2 = events[j].get("_start_dt")
            e2_end = events[j].get("_end_dt")

            if not all([s1, e1_end, s2, e2_end]):
                continue

            if s1 < e2_end and e1_end > s2:
                events[i]["conflict"] = True

    # ------------------------------------------
    # STEP 5: CLEAN OUTPUT
    # ------------------------------------------
    for e in events:
        e["start"] = to_iso(e.get("_start_dt"))
        e["end"] = to_iso(e.get("_end_dt"))

        e.pop("_start_dt", None)
        e.pop("_end_dt", None)

    # ------------------------------------------
    # FINAL RESPONSE
    # ------------------------------------------
    accounts = MultiAccountOAuthService.get_user_accounts(db, current_user.id)


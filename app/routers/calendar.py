
# ==================================================
# IMPORTS
# ==================================================

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from datetime import datetime, timedelta, timezone

from app.database import get_db
from app.models import Event, Note
from app.deps import get_current_user

from app.services.calendar_service import CalendarService
from app.services.multi_account_oauth_service import MultiAccountOAuthService


print("✅ CALENDAR ROUTER FILE LOADED")

router = APIRouter(prefix="/calendar", tags=["calendar"])

calendar_service = CalendarService()


# ==================================================
# ✅ SAFE HELPERS
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
# ✅ UNIFIED CALENDAR (FINAL CLEAN VERSION)
# ==================================================

@router.get("/unified")
def get_unified_calendar(
    range_days: int = Query(30),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):

    now = datetime.utcnow()
    start_date = now - timedelta(days=range_days)
    end_date = now + timedelta(days=range_days)

    print(f"✅ RANGE WINDOW: ±{range_days} days")

    # ------------------------------------------
    # STEP 1: FETCH EXTERNAL EVENTS
    # ------------------------------------------
    try:
        events = calendar_service.fetch_all_events(
            db,
            current_user,
            start_date=start_date,
            end_date=end_date
        ) or []

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
    db_events = db.query(Event).filter(
        Event.owner_id == current_user.id,
        Event.end_time >= start_date,
        Event.start_time <= end_date
    ).all()

    for e in db_events:

        # ✅ Skip synced external copies
        if e.externalId:
            continue

        events.append({
            "id": e.id,
            "external_id": None,
            "title": e.title,
            "start": to_iso(e.start_time),
            "end": to_iso(e.end_time),

            "source": "local",
            "provider": "local",

            "account": "local",
            "account_key": "local:local",

            "color": "#666666",
            "conflict": False,

            "_start_dt": to_dt(e.start_time),
            "_end_dt": to_dt(e.end_time)
        })

    # ------------------------------------------
    # STEP 3: DEDUPE (CORRECT PLACE ✅)
    # ------------------------------------------
    seen = set()
    unique_events = []

    for e in events:
        key = (
            e.get("external_id"),
            e.get("source"),              # ✅ CRITICAL FIX
            str(e.get("_start_dt"))
        )

        if key in seen:
            continue

        seen.add(key)
        unique_events.append(e)

    events = unique_events

    # ------------------------------------------
    # STEP 4: SORT
    # ------------------------------------------
    FAR_FUTURE = datetime(9999, 1, 1, tzinfo=timezone.utc)

    def sort_key(e):
        return e.get("_start_dt") or FAR_FUTURE

    events.sort(key=sort_key)

    # ------------------------------------------
    # STEP 5: CONFLICT DETECTION
    # ------------------------------------------
    for i in range(len(events)):
        events[i]["conflict"] = False

        for j in range(len(events)):
            if i == j:
                continue

            s1 = events[i].get("_start_dt")
            e1 = events[i].get("_end_dt")
            s2 = events[j].get("_start_dt")
            e2 = events[j].get("_end_dt")

            if not all([s1, e1, s2, e2]):
                continue

            if s1 < e2 and e1 > s2:
                events[i]["conflict"] = True

    # ------------------------------------------
    # STEP 6: CLEAN OUTPUT
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

    return {
        "events": events,
        "accounts": accounts
    }


# ==================================================
# IMPORTS
# ==================================================

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.orm import Session
from datetime import datetime, timedelta

from app.database import get_db
from app.models import Event, Note

from app.deps import get_current_user

# ✅ Services
from app.services.calendar_service import CalendarService
from app.services.event_actions import EventActions
from app.services.google_calendar_service import GoogleCalendarService
from app.services.graph_client import GraphClient
from app.services.multi_account_oauth_service import MultiAccountOAuthService


print("✅ CALENDAR ROUTER FILE LOADED")


# ==================================================
# ROUTER SETUP (ONLY DEFINE ONCE ✅)
# ==================================================

router = APIRouter(
    prefix="/calendar",
    tags=["calendar"]
)

calendar_service = CalendarService()
event_actions = EventActions()
google_service = GoogleCalendarService()
graph_client = GraphClient()


# ==================================================
# GET CALENDAR BY DATE (LOCAL VIEW)
# ==================================================

@router.get("/")
def get_calendar(
    date: str = Query(...),
    db: Session = Depends(get_db)
):
    """
    ✅ Retrieve events + notes for a specific day
    """

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

    def to_iso(val):
        if not val:
            return None
        return val if isinstance(val, str) else val.isoformat()

    formatted_events = []
    for e in events:
        formatted_events.append({
            "id": str(e.id),
            "title": e.title,
            "start": to_iso(e.start_time),
            "end": to_iso(e.end_time),
            "extendedProps": {
                "description": e.description or "",
                "status": getattr(e, "status", "pending"),
                "source": getattr(e, "source", "local")
            }
        })

    notes = db.query(Note).filter(
        Note.date == date
    ).all()

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
# OUTLOOK SYNC (RAW PULL)
# ==================================================

@router.get("/sync/events")
def sync_events(db: Session = Depends(get_db)):
    """
    ✅ Pull events from Microsoft (no DB write)
    """
    try:
        return calendar_service.sync_events(db)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sync/tasks")
def sync_tasks(db: Session = Depends(get_db)):
    """
    ✅ Pull tasks from Microsoft
    """
    try:
        return calendar_service.sync_tasks(db)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================================================
# MANUAL SYNC (IMPORTANT ✅)
# ==================================================

@router.post("/sync")
def manual_sync(
    db: Session = Depends(get_db),
    current_user = Depends(get_current_user)
):
    """
    ✅ Run full sync for all accounts
    """
    result = calendar_service.sync_all(db, current_user)

    return {
        "message": "Sync completed ✅",
        "user_id": current_user.id,
        "result": result
    }


# ==================================================
# ✅ UNIFIED CALENDAR (MAIN API ✅)
# ==================================================
@router.get("/unified")
def get_unified_calendar(
    db: Session = Depends(get_db),
    current_user = Depends(get_current_user)
):
    """
    ✅ ENHANCED UNIFIED CALENDAR
    - Pulls multi-account events (Google + Microsoft)
    - Merges with local DB
    - Adds color coding
    - Detects conflicts
    """

    # --------------------------------------------------
    # ✅ STEP 1: FETCH MULTI-ACCOUNT EVENTS
    # --------------------------------------------------
    
    try:
        events = calendar_service.fetch_all_events(db, current_user)
    except Exception as e:
        print(f"❌ fetch_all_events failed: {e}")
        events = []

    # ✅ ALWAYS SAFE
    if not events:
        events = []

    print(f"✅ External events fetched: {len(events)}")
    

    # --------------------------------------------------
    # ✅ STEP 2: ADD LOCAL EVENTS (KEEP YOUR EXISTING LOGIC)
    # --------------------------------------------------
    now = datetime.utcnow()
    future_limit = now + timedelta(days=30)

    db_events = db.query(Event).filter(
        Event.owner_id == current_user.id,
        Event.end_time >= now,
        Event.start_time <= future_limit
    ).all()

    for e in db_events:
        events.append({
            "id": e.id,
            "external_id": e.externalId,
            "title": e.title,

            "start": e.start_time.isoformat() if e.start_time else None,
            "end": e.end_time.isoformat() if e.end_time else None,

            "source": "local",
            "account": "local",
            "color": "#666666",
            "conflict": False  # ✅ default (important)
        })

    # --------------------------------------------------
    # ✅ STEP 3: SORT EVENTS (SAFE)
    # --------------------------------------------------
    def safe_time(e):
        return e.get("start") or "9999"


    events.sort(key=safe_time)

    # --------------------------------------------------
    # ✅ STEP 4: CONFLICT DETECTION
    # --------------------------------------------------
    for i in range(len(events)):
        events[i]["conflict"] = False

        for j in range(len(events)):
            if i == j:
                continue

            e1 = events[i]
            e2 = events[j]

            if not e1.get("start") or not e2.get("start"):
                continue

            if (
                e1.get("start") and e1.get("end") and
                e2.get("start") and e2.get("end") and
                e1["start"] < e2["end"] and
                e1["end"] > e2["start"]
            ):
                events[i]["conflict"] = True

    # --------------------------------------------------
    # ✅ FINAL RESPONSE (CLEAN)
    # --------------------------------------------------
    # ✅ Get accounts
    accounts = MultiAccountOAuthService.get_user_accounts(db, current_user.id)

    return {
        "user_id": current_user.id,
        "count": len(events),
        "events": events,
        "accounts": accounts
    }



# ==================================================
# UPDATE EVENT
# ==================================================

@router.put("/event/{event_id}")
def update_event(
    event_id: int,
    updates: dict,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_user)
):
    event = db.query(Event).filter(
        Event.id == event_id,
        Event.owner_id == current_user.id
    ).first()

    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    return event_actions.update_event(
        db,
        event,
        updates,
        google_service,
        graph_client,
        current_user
    )


# ==================================================
# DELETE EVENT
# ==================================================

@router.delete("/event/{event_id}")
def delete_event(
    event_id: int,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_user)
):
    event = db.query(Event).filter(
        Event.id == event_id,
        Event.owner_id == current_user.id
    ).first()

    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    return event_actions.delete_event(
        db,
        event,
        google_service,
        graph_client,
        current_user
    )


# ==================================================
# CREATE EVENT
# ==================================================

@router.post("/event")
def create_event(
    data: dict,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_user)
):
    title = data.get("title")
    start_time = datetime.fromisoformat(data.get("start_time"))
    end_time = datetime.fromisoformat(data.get("end_time"))

    google_id = None
    outlook_id = None

    try:
        google_id = google_service.create_event(
            current_user.google_access_token,
            title,
            start_time,
            end_time
        )
    except Exception as e:
        print("❌ Google create failed:", e)

    try:
        outlook_id = graph_client.create_event(
            current_user.ms_access_token,
            title,
            start_time,
            end_time
        )
    except Exception as e:
        print("❌ Outlook create failed:", e)

    new_event = Event(
        title=title,
        start_time=start_time,
        end_time=end_time,
        source="google,outlook",
        externalId=f"{title}|{start_time}|{end_time}",
        external_ids={
            "google": google_id,
            "outlook": outlook_id
        },
        owner_id=current_user.id
    )

    db.add(new_event)
    db.commit()

    return {"status": "created"}

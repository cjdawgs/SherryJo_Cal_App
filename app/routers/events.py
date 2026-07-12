
## ===============================
## IMPORTS
## ===============================
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from datetime import datetime

from app.database import get_db
from app.deps import get_current_user
from app.models import Event, Note


## ===============================
## ROUTER SETUP
## ===============================
router = APIRouter(prefix="/events", tags=["events"])


## ===============================
## ✅ GET EVENTS (WITH NOTES)
## ===============================
@router.get("/")
def get_events(db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    """
    ✅ Returns events for the authenticated user only
    ✅ Includes notes for UI icons + hover
    """

    events = db.query(Event).filter(Event.owner_id == current_user.id).all()

    def to_iso(val):
        if not val:
            return None
        return val.isoformat() if hasattr(val, "isoformat") else str(val)

    out = []

    for e in events:

        # ✅ Safe note extraction
        try:
            notes_list = e.notes if e.notes else []
        except:
            notes_list = []

        safe_notes = []

        for n in notes_list:
            try:
                safe_notes.append({
                    "id": n.id,
                    "content": n.content,
                    "color": getattr(n, "color", "yellow"),
                    "x": getattr(n, "x", 120),
                    "y": getattr(n, "y", 120),
                })
            except:
                continue

        out.append({
            "id": str(e.id),
            "title": e.title,
            "start": to_iso(e.start_time),
            "end": to_iso(e.end_time),

            "hasNote": len(safe_notes) > 0,
            "notes": safe_notes,

            "extendedProps": {
                "description": getattr(e, "description", ""),
                "status": getattr(e, "status", ""),
                "source": getattr(e, "source", "")
            }
        })

    return out


## ==================================================
## ✅ SMART CREATE / UPDATE EVENT (ONE ENDPOINT)
## ==================================================
@router.post("/update-event")
def update_event(payload: dict, db: Session = Depends(get_db)):
    """
    ✅ This handles BOTH:
       - Create new event (no id)
       - Update existing event (has id)

    ✅ This replaces needing separate create + update endpoints
    """

    # ✅ Get values safely
    event_id = payload.get("id")
    title = payload.get("title")
    description = payload.get("description")
    start_time = payload.get("start_time")
    end_time = payload.get("end_time")

    # ✅ Convert times safely
    start_dt = datetime.fromisoformat(start_time) if start_time else None
    end_dt = datetime.fromisoformat(end_time) if end_time else None


    # ==================================================
    # ✅ CREATE NEW EVENT (NO ID)
    # ==================================================
    if not event_id:
        new_event = Event(
            title=title,
            description=description,
            start_time=start_dt,
            end_time=end_dt,

            # ✅ You can change this if you have auth users later
            owner_id=payload.get("owner_id", 1)
        )

        db.add(new_event)
        db.commit()
        db.refresh(new_event)

        return {
            "ok": True,
            "status": "created",
            "id": new_event.id
        }


    # ==================================================
    # ✅ UPDATE EXISTING EVENT
    # ==================================================
    event_id = int(event_id)

    e = db.query(Event).filter(Event.id == event_id).first()

    if not e:
        return {"ok": False, "error": "Event not found"}

    # ✅ Only update fields if provided
    if title is not None:
        e.title = title

    if description is not None:
        e.description = description

    if start_dt is not None:
        e.start_time = start_dt

    if end_dt is not None:
        e.end_time = end_dt

    db.commit()

    return {
        "ok": True,
        "status": "updated"
    }


@router.post("/")
def create_or_update_event_legacy(payload: dict, db: Session = Depends(get_db)):
    """
    Legacy compatibility endpoint for tests/clients posting to /events/.
    Delegates to the unified update-event logic and returns event fields.
    """
    result = update_event(payload=payload, db=db)

    event_id = result.get("id") or payload.get("id")
    event_obj = None
    if event_id:
        event_obj = db.query(Event).filter(Event.id == int(event_id)).first()

    if event_obj is None:
        return {
            "id": event_id,
            "title": payload.get("title"),
            "description": payload.get("description"),
            "start_time": payload.get("start_time"),
            "end_time": payload.get("end_time")
        }

    return {
        "id": event_obj.id,
        "title": event_obj.title,
        "description": event_obj.description,
        "start_time": event_obj.start_time.isoformat() if event_obj.start_time else None,
        "end_time": event_obj.end_time.isoformat() if event_obj.end_time else None
    }


## ==================================================
## ✅ NOTES (CREATE / UPDATE / POSITION)
## ==================================================
@router.post("/note")
def upsert_note(payload: dict, db: Session = Depends(get_db)):
    """
    ✅ Handles:
    - Create note
    - Update content
    - Update position (x, y)
    """

    note_id = payload.get("note_id")

    # ✅ UPDATE EXISTING NOTE
    if note_id:
        note = db.query(Note).filter(Note.id == note_id).first()

        if note:
            note.content = payload.get("content", note.content)

            # ✅ Update position if provided
            if "x" in payload:
                note.x = payload["x"]

            if "y" in payload:
                note.y = payload["y"]

    else:
        # ✅ CREATE NEW NOTE
        note = Note(
            event_id=int(payload["event_id"]),
            content=payload.get("content", ""),
            color="yellow",

            # ✅ Default position
            x=payload.get("x", 120),
            y=payload.get("y", 120),
        )

        db.add(note)

    db.commit()

    return {"ok": True}

# --------------------------------------------------
# IMPORTS
# --------------------------------------------------
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models import Event, Note, User


# --------------------------------------------------
# ROUTER SETUP
# --------------------------------------------------

router = APIRouter(prefix="/notes", tags=["notes"])


# --------------------------------------------------
# GET NOTES BY DATE
# --------------------------------------------------

@router.get("/")
def get_notes(
    date: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    notes = (
        db.query(Note)
        .join(Event, Note.event_id == Event.id)
        .filter(Note.date == date, Event.owner_id == current_user.id)
        .all()
    )

    return notes


# --------------------------------------------------
# CREATE NOTE
# --------------------------------------------------

@router.post("/")
def create_note(
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    date = payload["date"]
    event_id = payload.get("event_id")

    if not event_id:
        raise HTTPException(status_code=400, detail="event_id is required")

    event = (
        db.query(Event)
        .filter(Event.id == event_id, Event.owner_id == current_user.id)
        .first()
    )

    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # ✅ Check if note already exists for this event + date
    existing = db.query(Note).filter(
        Note.date == date,
        Note.event_id == event_id
    ).first()

    if existing:
        # ✅ UPDATE instead of creating new
        existing.content = payload["content"]
        db.commit()
        db.refresh(existing)
        return existing

    # ✅ Otherwise create new
    note = Note(
        date=date,
        content=payload["content"],
        event_id=event_id,
    )

    db.add(note)
    db.commit()
    db.refresh(note)

    return note
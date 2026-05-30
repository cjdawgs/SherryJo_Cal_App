# --------------------------------------------------
# IMPORTS
# --------------------------------------------------
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Note


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
):
    notes = db.query(Note).filter(Note.date == date).all()

    return notes


# --------------------------------------------------
# CREATE NOTE
# --------------------------------------------------

@router.post("/")
def create_note(
    payload: dict,
    db: Session = Depends(get_db),
):
    date = payload["date"]
    event_id = payload.get("event_id")

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
        owner_id=payload.get("owner_id"),
    )

    db.add(note)
    db.commit()
    db.refresh(note)

    return note
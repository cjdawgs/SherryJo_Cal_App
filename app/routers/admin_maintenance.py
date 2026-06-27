from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_admin
from app.models import DateStickyNote, Event, Note, OAuthAccount, Task, User


router = APIRouter(prefix="/admin/maintenance", tags=["admin-maintenance"])


class OrphanDeleteRequest(BaseModel):
    entities: list[str] | None = None


def _scan_orphans(db: Session, limit: int = 500):
    orphan_accounts = [
        row[0]
        for row in db.query(OAuthAccount.id)
        .outerjoin(User, OAuthAccount.user_id == User.id)
        .filter(User.id.is_(None))
        .limit(limit)
        .all()
    ]

    orphan_events = [
        row[0]
        for row in db.query(Event.id)
        .outerjoin(User, Event.owner_id == User.id)
        .filter(Event.owner_id.is_not(None), User.id.is_(None))
        .limit(limit)
        .all()
    ]

    orphan_notes = [
        row[0]
        for row in db.query(Note.id)
        .outerjoin(Event, Note.event_id == Event.id)
        .filter(Note.event_id.is_not(None), Event.id.is_(None))
        .limit(limit)
        .all()
    ]

    orphan_tasks = [
        row[0]
        for row in db.query(Task.id)
        .outerjoin(User, Task.owner_id == User.id)
        .filter(Task.owner_id.is_not(None), User.id.is_(None))
        .limit(limit)
        .all()
    ]

    orphan_sticky = [
        row[0]
        for row in db.query(DateStickyNote.id)
        .outerjoin(User, DateStickyNote.owner_id == User.id)
        .filter(DateStickyNote.owner_id.is_not(None), User.id.is_(None))
        .limit(limit)
        .all()
    ]

    # A user is considered orphaned when they have no managed linked records.
    orphan_users = [
        row[0]
        for row in db.query(User.id)
        .outerjoin(OAuthAccount, OAuthAccount.user_id == User.id)
        .outerjoin(Event, Event.owner_id == User.id)
        .outerjoin(Task, Task.owner_id == User.id)
        .outerjoin(DateStickyNote, DateStickyNote.owner_id == User.id)
        .filter(
            OAuthAccount.id.is_(None),
            Event.id.is_(None),
            Task.id.is_(None),
            DateStickyNote.id.is_(None),
        )
        .limit(limit)
        .all()
    ]

    return {
        "users": orphan_users,
        "oauth_accounts": orphan_accounts,
        "events": orphan_events,
        "notes": orphan_notes,
        "tasks": orphan_tasks,
        "date_sticky_notes": orphan_sticky,
    }


@router.get("/orphans")
def admin_scan_orphans(
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    data = _scan_orphans(db)
    return {
        "orphans": data,
        "counts": {key: len(value) for key, value in data.items()},
    }


@router.post("/orphans/delete")
def admin_delete_orphans(
    payload: OrphanDeleteRequest,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    scan = _scan_orphans(db, limit=200000)
    target_entities = set(payload.entities or scan.keys())

    deleted = {
        "users": 0,
        "oauth_accounts": 0,
        "events": 0,
        "notes": 0,
        "tasks": 0,
        "date_sticky_notes": 0,
    }

    if "notes" in target_entities and scan["notes"]:
        deleted["notes"] = db.query(Note).filter(Note.id.in_(scan["notes"])).delete(synchronize_session=False)

    if "events" in target_entities and scan["events"]:
        deleted["events"] = db.query(Event).filter(Event.id.in_(scan["events"])).delete(synchronize_session=False)

    if "oauth_accounts" in target_entities and scan["oauth_accounts"]:
        deleted["oauth_accounts"] = db.query(OAuthAccount).filter(
            OAuthAccount.id.in_(scan["oauth_accounts"])
        ).delete(synchronize_session=False)

    if "tasks" in target_entities and scan["tasks"]:
        deleted["tasks"] = db.query(Task).filter(Task.id.in_(scan["tasks"])).delete(synchronize_session=False)

    if "date_sticky_notes" in target_entities and scan["date_sticky_notes"]:
        deleted["date_sticky_notes"] = db.query(DateStickyNote).filter(
            DateStickyNote.id.in_(scan["date_sticky_notes"])
        ).delete(synchronize_session=False)

    if "users" in target_entities and scan["users"]:
        deleted["users"] = db.query(User).filter(User.id.in_(scan["users"])).delete(synchronize_session=False)

    db.commit()

    return {
        "deleted": {key: int(value) for key, value in deleted.items()},
        "requested_entities": sorted(target_entities),
    }

from datetime import datetime
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import String, cast, func, inspect, or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_admin
from app.models import DateStickyNote, Event, Note, OAuthAccount, Roles, Task, User
from app.security import hash_password


router = APIRouter(prefix="/admin/users", tags=["admin-users"])
logger = logging.getLogger(__name__)


class AdminUserCreateRequest(BaseModel):
    email: EmailStr
    username: str = Field(min_length=1, max_length=120)
    role: str = Field(pattern=r"^(admin|staff)$")
    password: str = Field(min_length=8, max_length=256)


class AdminUserUpdateRequest(BaseModel):
    email: EmailStr
    username: str = Field(min_length=1, max_length=120)
    role: str = Field(pattern=r"^(admin|staff)$")


class AdminPasswordResetRequest(BaseModel):
    new_password: str = Field(min_length=8, max_length=256)


class AdminBulkDeleteUsersRequest(BaseModel):
    ids: list[int] = Field(min_length=1)
    delete_related: bool = True


def serialize_user(user: User) -> dict:
    created_at = user.created_at
    if isinstance(created_at, datetime):
        created_at = created_at.isoformat()

    return {
        "id": user.id,
        "email": user.email,
        "username": user.username,
        "role": user.role,
        "created_at": created_at,
    }


def _collect_user_account_emails(user: User, account_rows: list[OAuthAccount]) -> set[str]:
    emails = {
        str(user.email or "").lower().strip(),
        str(getattr(user, "google_email", "") or "").lower().strip(),
        str(getattr(user, "ms_email", "") or "").lower().strip(),
    }

    for row in account_rows:
        emails.add(str(row.account_email or "").lower().strip())

    return {email for email in emails if email}


def _build_user_event_filters(user_id: int, account_emails: set[str]):
    filters = [Event.owner_id == user_id]
    if account_emails:
        filters.append(func.lower(Event.account_email).in_(list(account_emails)))
    return filters


def _date_sticky_owner_filter(user_id: int):
    # Production schemas may have owner_id stored as TEXT in legacy environments.
    # Cast to text to support both integer and text columns safely.
    return cast(DateStickyNote.owner_id, String) == str(user_id)


def _event_has_sticky_payload(sticky_note, sticky_notes) -> bool:
    if isinstance(sticky_note, dict):
        if str(sticky_note.get("content") or "").strip():
            return True
    elif sticky_note not in (None, "", {}, []):
        return True

    if isinstance(sticky_notes, list):
        for item in sticky_notes:
            if isinstance(item, dict):
                if str(item.get("content") or "").strip():
                    return True
            elif item not in (None, ""):
                return True
    elif sticky_notes not in (None, "", {}, []):
        return True

    return False


def _delete_user_related_records(db: Session, user: User) -> dict:
    bind = db.get_bind()
    existing_tables = set(inspect(bind).get_table_names()) if bind is not None else set()

    account_rows = []
    if "oauth_accounts" in existing_tables:
        account_rows = db.query(OAuthAccount).filter(OAuthAccount.user_id == user.id).all()

    account_emails = _collect_user_account_emails(user, account_rows)

    notes_deleted = 0
    events_deleted = 0
    if "events" in existing_tables:
        event_filters = _build_user_event_filters(user.id, account_emails)

        event_id_subquery = db.query(Event.id).filter(or_(*event_filters)).subquery()

        if "notes" in existing_tables:
            notes_deleted = db.query(Note).filter(
                Note.event_id.in_(db.query(event_id_subquery.c.id))
            ).delete(synchronize_session=False)

        events_deleted = db.query(Event).filter(
            Event.id.in_(db.query(event_id_subquery.c.id))
        ).delete(synchronize_session=False)

    tasks_deleted = 0
    if "tasks" in existing_tables:
        tasks_deleted = db.query(Task).filter(Task.owner_id == user.id).delete(synchronize_session=False)

    sticky_deleted = 0
    if "date_sticky_notes" in existing_tables:
        sticky_deleted = db.query(DateStickyNote).filter(_date_sticky_owner_filter(user.id)).delete(synchronize_session=False)

    accounts_deleted = 0
    if "oauth_accounts" in existing_tables:
        accounts_deleted = db.query(OAuthAccount).filter(OAuthAccount.user_id == user.id).delete(synchronize_session=False)

    return {
        "accounts_deleted": int(accounts_deleted),
        "events_deleted": int(events_deleted),
        "notes_deleted": int(notes_deleted),
        "tasks_deleted": int(tasks_deleted),
        "sticky_notes_deleted": int(sticky_deleted),
    }


@router.get("")
def admin_list_users(
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    users = db.query(User).order_by(User.id.asc()).all()
    return [serialize_user(user) for user in users]


@router.post("")
def admin_create_user(
    payload: AdminUserCreateRequest,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    email_owner = db.query(User).filter(User.email == payload.email).first()
    if email_owner:
        raise HTTPException(status_code=409, detail="Email already in use")

    username_owner = db.query(User).filter(User.username == payload.username).first()
    if username_owner:
        raise HTTPException(status_code=409, detail="Username already in use")

    role = (payload.role or Roles.STAFF).strip().lower()
    if role not in {Roles.ADMIN, Roles.STAFF}:
        raise HTTPException(status_code=422, detail="Role must be 'admin' or 'staff'")

    new_user = User(
        email=payload.email,
        username=payload.username,
        role=role,
        hashed_password=hash_password(payload.password),
    )

    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    return serialize_user(new_user)


@router.get("/{user_id}")
def admin_get_user(
    user_id: int,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    return serialize_user(user)


@router.put("/{user_id}")
def admin_update_user(
    user_id: int,
    payload: AdminUserUpdateRequest,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    email_owner = db.query(User).filter(User.email == payload.email, User.id != user_id).first()
    if email_owner:
        raise HTTPException(status_code=409, detail="Email already in use")

    username_owner = db.query(User).filter(User.username == payload.username, User.id != user_id).first()
    if username_owner:
        raise HTTPException(status_code=409, detail="Username already in use")

    next_role = (payload.role or Roles.STAFF).strip().lower()
    if next_role not in {Roles.ADMIN, Roles.STAFF}:
        raise HTTPException(status_code=422, detail="Role must be 'admin' or 'staff'")

    user.email = payload.email
    user.username = payload.username
    user.role = next_role

    db.commit()
    db.refresh(user)

    return serialize_user(user)


@router.delete("/{user_id}")
def admin_delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if user.id == admin_user.id:
        raise HTTPException(status_code=400, detail="Admin cannot delete current session user")

    db.delete(user)
    db.commit()

    return {"deleted": True, "id": user_id}


@router.post("/{user_id}/reset-password")
def admin_reset_user_password(
    user_id: int,
    payload: AdminPasswordResetRequest,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.hashed_password = hash_password(payload.new_password)

    db.commit()
    db.refresh(user)

    return {"reset": True, "id": user.id}


@router.get("/{user_id}/related-data")
def admin_get_user_related_data(
    user_id: int,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    account_rows = db.query(OAuthAccount).filter(OAuthAccount.user_id == user.id).all()
    account_emails = _collect_user_account_emails(user, account_rows)
    event_filters = _build_user_event_filters(user.id, account_emails)

    matched_events = db.query(Event.id, Event.sticky_note, Event.sticky_notes).filter(or_(*event_filters)).all()
    matched_event_ids = [row.id for row in matched_events]
    event_count = len(matched_event_ids)

    notes_count = 0
    if matched_event_ids:
        notes_count = int(
            db.query(Note)
            .filter(Note.event_id.in_(matched_event_ids))
            .count()
        )

    event_sticky_count = sum(
        1
        for row in matched_events
        if _event_has_sticky_payload(row.sticky_note, row.sticky_notes)
    )

    date_sticky_count = int(db.query(DateStickyNote).filter(_date_sticky_owner_filter(user.id)).count())
    sticky_total = date_sticky_count + int(event_sticky_count)

    return {
        "user": serialize_user(user),
        "related": {
            "accounts": len(account_rows),
            "events": int(event_count),
            "tasks": int(db.query(Task).filter(Task.owner_id == user.id).count()),
            "sticky_notes": int(sticky_total),
            "date_sticky_notes": int(date_sticky_count),
            "event_sticky_notes": int(event_sticky_count),
            "notes": int(notes_count),
        },
    }


@router.post("/{user_id}/purge-related")
def admin_purge_user_related_data(
    user_id: int,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    try:
        deleted = _delete_user_related_records(db, user)
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.exception("Admin purge-related failed for user_id=%s", user_id)
        raise HTTPException(status_code=500, detail=f"Purge failed: {exc}")

    return {
        "purged": True,
        "user_id": user_id,
        "deleted": deleted,
    }


@router.post("/bulk-delete")
def admin_bulk_delete_users(
    payload: AdminBulkDeleteUsersRequest,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    target_ids = sorted({int(v) for v in payload.ids if int(v) > 0})
    if not target_ids:
        raise HTTPException(status_code=422, detail="No valid user ids provided")

    users = db.query(User).filter(User.id.in_(target_ids)).all()
    users_by_id = {u.id: u for u in users}

    deleted_users = 0
    skipped = []
    aggregate = {
        "accounts_deleted": 0,
        "events_deleted": 0,
        "notes_deleted": 0,
        "tasks_deleted": 0,
        "sticky_notes_deleted": 0,
    }

    try:
        for user_id in target_ids:
            user = users_by_id.get(user_id)
            if not user:
                skipped.append({"id": user_id, "reason": "not_found"})
                continue

            if user.id == admin_user.id:
                skipped.append({"id": user_id, "reason": "current_admin_session"})
                continue

            try:
                with db.begin_nested():
                    deleted = {
                        "accounts_deleted": 0,
                        "events_deleted": 0,
                        "notes_deleted": 0,
                        "tasks_deleted": 0,
                        "sticky_notes_deleted": 0,
                    }

                    if payload.delete_related:
                        deleted = _delete_user_related_records(db, user)

                    db.delete(user)

                for key, value in deleted.items():
                    aggregate[key] += int(value)
                deleted_users += 1

            except Exception as user_exc:
                logger.exception("Admin bulk delete failed for user_id=%s", user_id)
                skipped.append({
                    "id": user_id,
                    "reason": "delete_failed",
                    "detail": str(user_exc)[:220],
                })

        db.commit()
    except Exception as exc:
        db.rollback()
        logger.exception("Admin bulk user delete transaction failed")
        raise HTTPException(status_code=500, detail=f"Bulk delete failed: {exc}")

    return {
        "deleted_users": deleted_users,
        "requested": len(target_ids),
        "skipped": skipped,
        "deleted_related": aggregate,
    }

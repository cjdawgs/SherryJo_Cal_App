from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_admin
from app.models import Roles, User
from app.security import hash_password


router = APIRouter(prefix="/admin/users", tags=["admin-users"])


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

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User
from app.deps import get_current_admin  # ✅ IMPORTANT
from app.security import hash_password

router = APIRouter(prefix="/admin", tags=["admin"])


# ==================================================
# ✅ LIST ALL USERS
# ==================================================
@router.get("/users")
def get_all_users(
    db: Session = Depends(get_db),
    admin_user: User = Depends(get_current_admin)
):
    """
    ✅ Only admins can see all users
    """

    users = db.query(User).all()

    return [
        {
            "id": u.id,
            "email": u.email,
            "username": u.username,
            "role": u.role
        }
        for u in users
    ]


# ==================================================
# ✅ MAKE USER ADMIN
# ==================================================
@router.put("/users/{user_id}/make-admin")
def make_admin(
    user_id: int,
    db: Session = Depends(get_db),
    admin_user: User = Depends(get_current_admin)
):
    """
    ✅ Promote user to admin
    """

    user = db.query(User).filter(User.id == user_id).first()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.role = "admin"
    db.commit()

    return {"message": f"User {user.email} is now admin ✅"}


# ==================================================
# ✅ RESET PASSWORD
# ==================================================
@router.put("/users/{user_id}/reset-password")
def reset_password(
    user_id: int,
    new_password: str,
    db: Session = Depends(get_db),
    admin_user: User = Depends(get_current_admin)
):
    """
    ✅ Reset user password
    """

    user = db.query(User).filter(User.id == user_id).first()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.hashed_password = hash_password(new_password)

    db.commit()

    return {"message": f"Password reset for {user.email} ✅"}

# --------------------------------------------------
# IMPORTS
# --------------------------------------------------

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user, get_current_admin  # ✅ UPDATED
from app.models import User


# --------------------------------------------------
# ROUTER SETUP
# --------------------------------------------------

router = APIRouter(prefix="/users", tags=["users"])


# --------------------------------------------------
# ADMIN ONLY: LIST ALL USERS
# --------------------------------------------------

@router.get("/")
def list_users(
    db: Session = Depends(get_db),
    
    # ✅ UPDATED: use admin dependency instead of manual role check
    current_user: User = Depends(get_current_admin),
):
    """
    ✅ Returns all users (ADMIN ONLY)

    🔥 CHANGE:
    - Removed manual role check
    - Now enforced via dependency (clean + reusable)
    """

    users = db.query(User).all()

    return [
        {
            "id": u.id,
            "email": u.email,
            "role": u.role
        }
        for u in users
    ]


# --------------------------------------------------
# CURRENT USER INFO
# --------------------------------------------------

@router.get("/me")
def me(current_user: User = Depends(get_current_user)):
    """
    ✅ Returns info for currently logged-in user
    🔒 No role restriction (any authenticated user)
    """

    return {
        "id": current_user.id,
        "email": current_user.email,
        "role": current_user.role,
    }
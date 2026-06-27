
# --------------------------------------------------
# IMPORTS
# --------------------------------------------------

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.database import get_db
from app.security import decode_token
from app.models import User, Roles  # ✅ UPDATED: import Roles


# --------------------------------------------------
# SECURITY SCHEME (Swagger UI integration)
# --------------------------------------------------

# ✅ Matches your Swagger "Authorize" button config
bearer = HTTPBearer(
    scheme_name="JWTBearer",
    description="Paste token as: Bearer <access_token> only include the token without the double quotes or Bearer prefix",
)


# --------------------------------------------------
# ✅ GET CURRENT USER (HARDENED AUTH FIX)
# --------------------------------------------------

def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(bearer),
    db: Session = Depends(get_db),
):
    """
    ✅ Improvements:
    - Validates token format safely
    - Handles expired tokens clearly
    - Guarantees consistent user object
    """

    if not creds or not creds.credentials:
        raise HTTPException(status_code=401, detail="Missing token")

    try:
        payload = decode_token(creds.credentials)

        # ✅ Strict validation
        user_id = payload.get("user_id")
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token payload")

    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    # ✅ DB lookup (prevents ghost users)
    user = db.query(User).filter(User.id == user_id).first()

    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    return user

# --------------------------------------------------
# ADMIN CHECK (NEW ✅ BEST PRACTICE)
# --------------------------------------------------

def require_admin(
    current_user: User = Depends(get_current_user),
) -> User:
    """
    ✅ Shared admin-only dependency for all management endpoints.
    """

    if current_user.role != Roles.ADMIN:
        raise HTTPException(status_code=403, detail="Admin only")

    return current_user


# Backward-compatible alias for existing imports.
get_current_admin = require_admin

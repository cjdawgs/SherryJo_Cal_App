# --------------------------------------------------
# IMPORTS
# --------------------------------------------------

import os
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from sqlalchemy import func
from pydantic import BaseModel, EmailStr, Field
from jose import jwt
from jose.exceptions import JWTError

from app.config import is_trusted_edge_request, settings
from app.database import get_db
from app.models import User, Roles
from app.security import hash_password, verify_password, create_token
from app.services.master_admin_code import (
    MAX_MASTER_ADMIN_CODE_LENGTH,
    MIN_MASTER_ADMIN_CODE_LENGTH,
    set_master_admin_code,
    verify_master_admin_code,
)


# --------------------------------------------------
# ROUTER SETUP
# --------------------------------------------------

router = APIRouter(prefix="/auth", tags=["auth"])


# --------------------------------------------------
# ✅ AUTH CONFIG (NEW)
# --------------------------------------------------

# ✅ This tells FastAPI how to extract token from request
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/login")

# ✅ IMPORTANT: must match your create_token() settings
SECRET_KEY = settings.jwt_secret_key
ALGORITHM = settings.jwt_algorithm


# --------------------------------------------------
# PYDANTIC SCHEMAS
# --------------------------------------------------
from passlib.context import CryptContext
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


class UserCreate(BaseModel):
    username: str
    email: EmailStr
    password: str
    role: str = Roles.STAFF
    master_admin_code: str | None = Field(default=None, max_length=MAX_MASTER_ADMIN_CODE_LENGTH)
    admin_setup_code: str | None = Field(default=None, max_length=MAX_MASTER_ADMIN_CODE_LENGTH)


class LoginRequest(BaseModel):
    email: str
    password: str


class MasterAdminCodeRecoveryRequest(BaseModel):
    recovery_code: str = Field(min_length=1, max_length=256)
    new_master_admin_code: str = Field(
        min_length=MIN_MASTER_ADMIN_CODE_LENGTH,
        max_length=MAX_MASTER_ADMIN_CODE_LENGTH,
    )


# --------------------------------------------------
# REGISTER USER
# --------------------------------------------------

@router.post("/register")
def register(user: UserCreate, db: Session = Depends(get_db)):

    existing_email = db.query(User).filter(User.email == user.email).first()
    if existing_email:
        raise HTTPException(status_code=400, detail="Email already registered")

    existing_username = db.query(User).filter(User.username == user.username).first()
    if existing_username:
        raise HTTPException(status_code=400, detail="Username already taken")

    role = (user.role or Roles.STAFF).strip().lower()
    if role not in {Roles.ADMIN, Roles.STAFF}:
        raise HTTPException(status_code=400, detail="Role must be 'admin' or 'staff'")

    if role == Roles.ADMIN:
        provided_code = user.master_admin_code or user.admin_setup_code or ""
        code_valid = verify_master_admin_code(db, provided_code)
        if code_valid is None:
            raise HTTPException(
                status_code=503,
                detail="Master Admin Code is not configured. An Admin must set it, or use emergency recovery.",
            )
        if not code_valid:
            raise HTTPException(status_code=403, detail="Invalid Master Admin Code.")

    new_user = User(
        username=user.username,
        email=user.email,
        hashed_password=hash_password(user.password),
        role=role
    )

    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    return {
        "message": "User created successfully",
        "id": new_user.id,
        "username": new_user.username,
        "email": new_user.email,
        "role": new_user.role
    }


@router.post("/admin-recovery/master-code")
def recover_master_admin_code(payload: MasterAdminCodeRecoveryRequest, db: Session = Depends(get_db)):
    expected_code = str(os.getenv("ADMIN_RECOVERY_CODE") or "")
    provided_code = payload.recovery_code
    if len(expected_code) < 32:
        raise HTTPException(
            status_code=503,
            detail="Master Admin Code recovery is unavailable because ADMIN_RECOVERY_CODE is missing or too short.",
        )
    if not secrets.compare_digest(provided_code.encode("utf-8"), expected_code.encode("utf-8")):
        raise HTTPException(status_code=403, detail="Invalid Master Admin Recovery Code.")
    set_master_admin_code(db, payload.new_master_admin_code)
    return {"reset": True, "configured": True}


# --------------------------------------------------
# LOGIN USER
# --------------------------------------------------

@router.post("/login")
def login(credentials: LoginRequest, request: Request, db: Session = Depends(get_db)):
    identifier = (credentials.email or "").strip().lower()
    if not identifier:
        raise HTTPException(status_code=401, detail="Invalid email, username, or password")

    identity_column = User.email if "@" in identifier else User.username
    user = db.query(User).filter(func.lower(identity_column) == identifier).first()

    if not user or not verify_password(credentials.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid email, username, or password")

    try:
        token = create_token(user.id)
    except JWTError as exc:
        raise HTTPException(status_code=503, detail="Session signing is unavailable") from exc

    if is_trusted_edge_request(request):
        token_alg = str(jwt.get_unverified_header(token).get("alg") or "").upper()
        if token_alg != "RS256":
            raise HTTPException(
                status_code=503,
                detail=(
                    "Cloudflare native authentication requires RS256 tokens. "
                    "Configure JWT_PRIVATE_KEY, JWT_ACTIVE_KID, JWT_PUBLIC_KEYS_JSON, JWT_ISSUER, and JWT_AUDIENCE."
                ),
            )

    return {
        "access_token": token,
        "token_type": "bearer"
    }


# --------------------------------------------------
# ✅ GET CURRENT USER (THIS WAS MISSING ✅)
# --------------------------------------------------

def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db)
):
    """
    ✅ Extract user from JWT token
    ✅ Used by:
       - /calendar/unified
       - OAuth callbacks (Google/MS)
       - Sync endpoints
    """

    try:
        # ✅ Decode JWT
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])

        user_id = payload.get("user_id")

        if user_id is None:
            raise HTTPException(status_code=401, detail="Invalid token")

    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")

    # ✅ Fetch user from DB
    user = db.query(User).filter(User.id == user_id).first()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    return user
# --------------------------------------------------
# IMPORTS
# --------------------------------------------------

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer  # ✅ NEW
from sqlalchemy.orm import Session
from pydantic import BaseModel, EmailStr
import os
import jwt  # ✅ NEW: used for decoding token

from app.database import get_db
from app.models import User, Roles
from app.security import hash_password, verify_password, create_token


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
SECRET_KEY = os.getenv("JWT_SECRET_KEY")
#SECRET_KEY = "SECRET_KEY"   # 🔥 Replace if you have a real one elsewhere
ALGORITHM = "HS256"


# --------------------------------------------------
# PYDANTIC SCHEMAS
# --------------------------------------------------
from passlib.context import CryptContext
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

from app.security import hash_password

@router.get("/debug/create-user")
def create_test_user(db: Session = Depends(get_db)):

    hashed_password = hash_password("test123")  # ✅ USE YOUR SYSTEM

    user = User(
        email="test@example.com",
        username="test",
        hashed_password=hashed_password,
        role="staff"
    )

    db.add(user)
    db.commit()

    return {"status": "created"}

class UserCreate(BaseModel):
    username: str
    email: EmailStr
    password: str
    role: str = Roles.STAFF


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


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

    # ✅ Prevent admin creation outside dev
    if user.role == Roles.ADMIN and os.getenv("ENV", "dev") != "dev":
        raise HTTPException(status_code=403, detail="Admin creation not allowed")

    new_user = User(
        username=user.username,
        email=user.email,
        hashed_password=hash_password(user.password),
        role=user.role if user.role else Roles.STAFF
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


# --------------------------------------------------
# LOGIN USER
# --------------------------------------------------

@router.post("/login")
def login(credentials: LoginRequest, db: Session = Depends(get_db)):

    user = db.query(User).filter(User.email == credentials.email).first()

    if not user or not verify_password(credentials.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    token = create_token(user.id)

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

# ==================================================
# ✅ TEMP: MAKE FIRST USER ADMIN
# ==================================================
@router.get("/debug/become-admin")
def become_admin(db: Session = Depends(get_db)):
    """
    ✅ TEMP TOOL:
    Makes the FIRST user in DB an admin

    Use ONCE, then delete it
    """

    user = db.query(User).first()

    if not user:
        return {"error": "No users found"}

    user.role = "admin"
    db.commit()

    return {
        "message": f"{user.email} is now admin ✅"
    }
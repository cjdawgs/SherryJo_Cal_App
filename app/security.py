
from datetime import datetime, timedelta, timezone
from passlib.context import CryptContext
from jose import jwt

from app.config import settings


# ✅ Password hashing (Argon2)
pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    return pwd_context.verify(password, hashed)


# ✅ JWT token creation
def create_token(user_id: int, minutes: int | None = 60) -> str:
    payload = {
        "user_id": user_id,
    }
    if minutes is not None:
        payload["exp"] = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def create_persistent_token(user_id: int) -> str:
    """Create a JWT that remains valid until explicitly revoked or re-signed."""
    return create_token(user_id, minutes=None)

def decode_token(token: str) -> dict:
    return jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])


import json
import uuid
from datetime import datetime, timedelta, timezone
from passlib.context import CryptContext
from jose import jwt
from jose.exceptions import JWTClaimsError, JWTError

from app.config import settings


# ✅ Password hashing (Argon2)
pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")
LEGACY_ALGORITHM = "HS256"
ASYMMETRIC_ALGORITHM = "RS256"


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    return pwd_context.verify(password, hashed)


def _create_legacy_token(user_id: int, minutes: int | None) -> str:
    payload = {
        "user_id": user_id,
    }
    if minutes is not None:
        payload["exp"] = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def _public_keyring() -> dict[str, str]:
    raw = str(getattr(settings, "jwt_public_keys_json", "") or "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise JWTError("JWT public keyring must be valid JSON") from exc
    if not isinstance(parsed, dict) or not all(
        isinstance(key, str) and key.strip() and isinstance(value, str) and value.strip()
        for key, value in parsed.items()
    ):
        raise JWTError("JWT public keyring must map non-empty key IDs to public keys")
    return parsed


def _asymmetric_signing_config() -> tuple[str, str] | None:
    private_key = str(getattr(settings, "jwt_private_key", "") or "").strip()
    active_kid = str(getattr(settings, "jwt_active_kid", "") or "").strip()
    if not private_key and not active_kid:
        return None
    if not private_key or not active_kid:
        raise JWTError("JWT asymmetric signing requires both jwt_private_key and jwt_active_kid")
    return private_key, active_kid


# ✅ JWT token creation
def create_token(user_id: int, minutes: int | None = 60) -> str:
    asymmetric = _asymmetric_signing_config()
    if asymmetric is None:
        return _create_legacy_token(user_id, minutes)
    if minutes is None:
        raise JWTError("Asymmetric access tokens require an expiration")

    private_key, active_kid = asymmetric
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "user_id": user_id,
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
        "iat": now,
        "nbf": now,
        "exp": now + timedelta(minutes=minutes),
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(
        payload,
        private_key,
        algorithm=ASYMMETRIC_ALGORITHM,
        headers={"kid": active_kid},
    )


def create_persistent_token(user_id: int) -> str:
    """Create a legacy Render-only token until revocable device credentials replace it."""
    return _create_legacy_token(user_id, minutes=None)


def decode_asymmetric_token(token: str) -> dict:
    """Verify a fully claimed RS256 token for Worker-compatible authentication."""
    header = jwt.get_unverified_header(token)
    if header.get("alg") != ASYMMETRIC_ALGORITHM:
        raise JWTError("Worker-compatible tokens must use RS256")

    kid = str(header.get("kid") or "").strip()
    public_key = _public_keyring().get(kid)
    if not kid or not public_key:
        raise JWTError("JWT key ID is missing or unknown")

    skew = max(0, int(getattr(settings, "jwt_clock_skew_seconds", 30) or 0))
    payload = jwt.decode(
        token,
        public_key,
        algorithms=[ASYMMETRIC_ALGORITHM],
        audience=settings.jwt_audience,
        issuer=settings.jwt_issuer,
        options={
            "require_aud": True,
            "require_iat": True,
            "require_exp": True,
            "require_nbf": True,
            "require_iss": True,
            "require_sub": True,
            "require_jti": True,
            "leeway": skew,
        },
    )
    now_timestamp = datetime.now(timezone.utc).timestamp()
    if float(payload["iat"]) > now_timestamp + skew:
        raise JWTClaimsError("JWT issued-at time is in the future")
    if payload.get("aud") != settings.jwt_audience:
        raise JWTClaimsError("JWT audience must be an exact string match")

    subject = payload.get("sub")
    user_id = payload.get("user_id")
    if (
        not isinstance(subject, str)
        or not subject.isdigit()
        or subject.startswith("0")
        or not isinstance(user_id, int)
        or isinstance(user_id, bool)
        or user_id <= 0
        or subject != str(user_id)
    ):
        raise JWTClaimsError("JWT subject does not match user_id")

    issued_at = float(payload["iat"])
    not_before = float(payload["nbf"])
    expires_at = float(payload["exp"])
    if not_before < issued_at - skew or expires_at <= not_before:
        raise JWTClaimsError("JWT time claims are inconsistent")
    max_lifetime = max(1, int(getattr(settings, "jwt_max_lifetime_seconds", 3600) or 0))
    if expires_at - issued_at > max_lifetime:
        raise JWTClaimsError("JWT lifetime exceeds the allowed maximum")
    return payload


def decode_token(token: str) -> dict:
    header = jwt.get_unverified_header(token)
    if header.get("alg") == ASYMMETRIC_ALGORITHM:
        return decode_asymmetric_token(token)
    if header.get("alg") != LEGACY_ALGORITHM or settings.jwt_algorithm != LEGACY_ALGORITHM:
        raise JWTError("JWT algorithm is not allowed")
    return jwt.decode(token, settings.jwt_secret_key, algorithms=[LEGACY_ALGORITHM])


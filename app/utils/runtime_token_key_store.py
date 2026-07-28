import base64
import hashlib
import os

from cryptography.fernet import Fernet
from sqlalchemy.orm import Session

from app.config import settings
from app.models import AppRuntimeSecret
from app.utils.crypto import reset_cipher_cache

TOKEN_KEY_SECRET_NAME = "token_encryption_key_v1"


def _wrapper_cipher() -> Fernet:
    jwt_secret = str(getattr(settings, "jwt_secret_key", "") or "").strip()
    if not jwt_secret:
        raise RuntimeError("jwt_secret_key is required to protect persisted runtime secrets")

    digest = hashlib.sha256(jwt_secret.encode("utf-8")).digest()
    key = base64.urlsafe_b64encode(digest)
    return Fernet(key)


def _seal_runtime_secret(raw_value: str) -> str:
    return _wrapper_cipher().encrypt(raw_value.encode("utf-8")).decode("utf-8")


def _unseal_runtime_secret(sealed_value: str) -> str:
    return _wrapper_cipher().decrypt(sealed_value.encode("utf-8")).decode("utf-8")


def persist_token_encryption_key(db: Session, token_encryption_key: str) -> None:
    normalized = str(token_encryption_key or "").strip()
    if not normalized:
        raise ValueError("token_encryption_key is required")

    sealed = _seal_runtime_secret(normalized)
    row = db.query(AppRuntimeSecret).filter(AppRuntimeSecret.key_name == TOKEN_KEY_SECRET_NAME).first()
    if row:
        row.secret_value = sealed
    else:
        db.add(AppRuntimeSecret(key_name=TOKEN_KEY_SECRET_NAME, secret_value=sealed))


def load_persisted_token_encryption_key(db: Session) -> str | None:
    row = db.query(AppRuntimeSecret).filter(AppRuntimeSecret.key_name == TOKEN_KEY_SECRET_NAME).first()
    if not row or not row.secret_value:
        return None
    return _unseal_runtime_secret(str(row.secret_value))


def bootstrap_token_encryption_key_from_store(db: Session) -> bool:
    current = str(getattr(settings, "token_encryption_key", "") or "").strip()
    if current:
        return False

    persisted = load_persisted_token_encryption_key(db)
    if not persisted:
        return False

    os.environ["TOKEN_ENCRYPTION_KEY"] = persisted
    settings.token_encryption_key = persisted
    reset_cipher_cache()
    return True

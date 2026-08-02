"""Envelope encryption for credentials stored at rest.

Third-party credentials (Google/Microsoft OAuth tokens, iCloud app passwords)
live in ``oauth_accounts``. They are sealed with AES-128-CBC + HMAC (Fernet)
before they touch the database, so a database dump, a Supabase Studio session
or a leaked ``service_role`` key does not yield usable credentials.

Format
------
Sealed values are stored as ``v1:<fernet-token>``. Values without a known
version prefix are returned untouched, which makes the rollout zero-downtime:
rows written before encryption keep working and are re-sealed the next time
they are updated.

Configuration
-------------
``TOKEN_ENCRYPTION_KEY`` — one or more comma-separated urlsafe-base64 32-byte
keys. The first key encrypts; the remaining keys are accepted for decryption,
which is what makes key rotation possible without downtime.

Generate one with::

    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

When the key is absent (local development, tests) values pass through in clear
text. Production deployments must set it — ``app/config.py`` fails fast if it
is missing.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from app.config import settings

VERSION_PREFIX = "v1:"

# Values that are protocol markers rather than credentials. They stay in clear
# text because queries filter on them at the SQL level.
SENTINEL_VALUES = frozenset({"admin-placeholder-token", "__REAUTH_REQUIRED__"})


class TokenEncryptionError(RuntimeError):
    """Raised when a sealed value cannot be opened with the configured keys."""


@lru_cache(maxsize=1)
def _cipher() -> Optional[MultiFernet]:
    raw = (getattr(settings, "token_encryption_key", None) or "").strip()
    if not raw:
        return None

    keys = [part.strip() for part in raw.split(",") if part.strip()]
    try:
        return MultiFernet([Fernet(key) for key in keys])
    except (ValueError, TypeError) as exc:
        raise TokenEncryptionError(
            "TOKEN_ENCRYPTION_KEY is not a valid Fernet key. Generate one with: "
            "python -c \"from cryptography.fernet import Fernet; "
            "print(Fernet.generate_key().decode())\""
        ) from exc


def encryption_enabled() -> bool:
    """True when a usable encryption key is configured."""
    return _cipher() is not None


def reset_cipher_cache() -> None:
    """Drop the cached cipher (tests and key rotation)."""
    _cipher.cache_clear()


def seal(value: Optional[str]) -> Optional[str]:
    """Encrypt a credential for storage. Idempotent."""
    if value is None or value == "":
        return value

    if value in SENTINEL_VALUES:
        return value

    if value.startswith(VERSION_PREFIX):
        return value

    cipher = _cipher()
    if cipher is None:
        return value

    return VERSION_PREFIX + cipher.encrypt(value.encode("utf-8")).decode("utf-8")


def unseal(value: Optional[str]) -> Optional[str]:
    """Decrypt a stored credential. Unsealed legacy values pass through."""
    if value is None or value == "":
        return value

    if not value.startswith(VERSION_PREFIX):
        return value

    cipher = _cipher()
    if cipher is None:
        raise TokenEncryptionError(
            "Stored credential is encrypted but TOKEN_ENCRYPTION_KEY is not configured."
        )

    try:
        return cipher.decrypt(value[len(VERSION_PREFIX):].encode("utf-8")).decode("utf-8")
    except InvalidToken as exc:
        raise TokenEncryptionError(
            "Stored credential could not be decrypted with the configured "
            "TOKEN_ENCRYPTION_KEY. Was the key rotated without re-encrypting?"
        ) from exc


def rotate(value: Optional[str]) -> Optional[str]:
    """Re-encrypt a sealed credential with the first configured key."""
    if value is None or value == "" or value in SENTINEL_VALUES:
        return value

    if not value.startswith(VERSION_PREFIX):
        return seal(value)

    cipher = _cipher()
    if cipher is None:
        raise TokenEncryptionError(
            "Stored credential is encrypted but TOKEN_ENCRYPTION_KEY is not configured."
        )

    try:
        token = value[len(VERSION_PREFIX):].encode("utf-8")
        return VERSION_PREFIX + cipher.rotate(token).decode("utf-8")
    except InvalidToken as exc:
        raise TokenEncryptionError(
            "Stored credential could not be rotated with the configured "
            "TOKEN_ENCRYPTION_KEY keyring."
        ) from exc


def mask(value: Optional[str]) -> str:
    """Render a credential for logs and diagnostics. Never reveals the value."""
    if value is None or value == "":
        return ""
    if value in SENTINEL_VALUES:
        return value
    return "***"

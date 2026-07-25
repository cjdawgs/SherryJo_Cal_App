"""Helpers for the JWT ``state`` value shared by the OAuth login flows."""

from typing import Optional, Tuple

import jwt

STATE_ALGORITHM = "HS256"


def normalize_reconnect_email(value: Optional[str]) -> Optional[str]:
    """Lowercase/trim a reconnect hint, returning ``None`` when empty."""
    return (value or "").strip().lower() or None


def encode_oauth_state(user_id, reconnect_email: Optional[str], secret_key: str) -> str:
    """Build the signed ``state`` carried through a provider authorization redirect."""
    return jwt.encode(
        {"user_id": user_id, "reconnect": reconnect_email},
        secret_key,
        algorithm=STATE_ALGORITHM,
    )


def decode_oauth_state(state: str, secret_key: str) -> Tuple[Optional[int], str]:
    """Return ``(user_id, expected_reconnect)`` from a state token.

    Raises the underlying ``jwt`` error when the state cannot be decoded so
    callers keep control over their own failure responses.
    """
    payload = jwt.decode(state, secret_key, algorithms=[STATE_ALGORITHM])
    return payload.get("user_id"), (payload.get("reconnect") or "").strip().lower()


def decode_user_token(token: str, secret_key: str) -> Optional[int]:
    """Return the ``user_id`` embedded in an app JWT passed as a query param."""
    payload = jwt.decode(token, secret_key, algorithms=[STATE_ALGORITHM])
    return payload.get("user_id")

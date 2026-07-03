"""
TV Pairing Service
==================
In-memory pairing code store for Apple TV device pairing.

Design rules:
- Codes are one-time use
- TTL is strictly 10 minutes (600 seconds)
- Codes map to a user_id (session-bound)
- selectedDate is the single source of truth — never defaults to today()
- TV state is per-user (not global across users)
"""

import secrets
import string
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────

PAIRING_CODE_TTL_SECONDS = 600       # 10 minutes
PAIRING_CODE_ALPHABET = string.ascii_uppercase + string.digits


# ─────────────────────────────────────────────────
# IN-MEMORY PAIRING STORE
# ─────────────────────────────────────────────────

class _PairingStore:
    """
    Thread-safe (GIL) in-memory map of:
        pairingCode -> { user_id, expires_at, used }

    For production at scale, swap this backing store with Redis
    without changing the public interface.
    """

    def __init__(self):
        self._codes: dict = {}

    # ── code generation ────────────────────────────

    def _generate_code(self) -> str:
        """ABCD-1234 format — 8 random alphanumeric chars."""
        raw = "".join(secrets.choice(PAIRING_CODE_ALPHABET) for _ in range(8))
        return f"{raw[:4]}-{raw[4:]}"

    def create_code(self, user_id: int) -> dict:
        """
        Issue a new one-time pairing code for the given user.

        Returns:
            { pairingCode, expiresAt (ISO), expiresIn (seconds) }
        """
        # Purge expired codes before issuing a new one (cheap GC)
        self._purge_expired()

        code = self._generate_code()
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=PAIRING_CODE_TTL_SECONDS)

        self._codes[code] = {
            "user_id": user_id,
            "expires_at": expires_at,
            "used": False,
        }

        logger.info("TV_PAIR_CODE_ISSUED user_id=%s code=%s", user_id, code)

        return {
            "pairingCode": code,
            "expiresAt": expires_at.isoformat(),
            "expiresIn": PAIRING_CODE_TTL_SECONDS,
        }

    def redeem_code(self, code: str) -> Optional[int]:
        """
        Validate and consume a pairing code.

        Returns user_id on success, None on failure.
        """
        entry = self._codes.get(code)

        if entry is None:
            logger.warning("TV_PAIR_INVALID_CODE code=%s", code)
            return None

        if entry["used"]:
            logger.warning("TV_PAIR_ALREADY_USED code=%s", code)
            return None

        if datetime.now(timezone.utc) > entry["expires_at"]:
            del self._codes[code]
            logger.warning("TV_PAIR_EXPIRED code=%s", code)
            return None

        # Mark consumed (one-time use)
        entry["used"] = True
        user_id = entry["user_id"]
        del self._codes[code]

        logger.info("TV_PAIR_CODE_REDEEMED user_id=%s code=%s", user_id, code)
        return user_id

    def _purge_expired(self):
        """Remove all expired entries."""
        now = datetime.now(timezone.utc)
        expired = [k for k, v in self._codes.items() if now > v["expires_at"]]
        for k in expired:
            del self._codes[k]


# ─────────────────────────────────────────────────
# TV STATE STORE
# ─────────────────────────────────────────────────

class _TVStateStore:
    """
    Per-user TV state:
        { selectedDate, currentView, focusedEventId }

    selectedDate NEVER defaults to today() — it is only set explicitly
    by a client PATCH or by the pairing flow inheriting the web session date.
    """

    def __init__(self):
        self._states: dict[int, dict] = {}

    def get(self, user_id: int) -> Optional[dict]:
        return self._states.get(user_id)

    def set(self, user_id: int, patch: dict) -> dict:
        """
        Merge patch into existing state. Ignores unknown keys.
        Returns the full updated state.
        """
        current = self._states.get(user_id, {})

        allowed_keys = {"selectedDate", "currentView", "focusedEventId",
                        "sleepGuardEnabled", "sleepGuardTimeoutMinutes"}
        for key in allowed_keys:
            if key in patch:
                current[key] = patch[key]

        self._states[user_id] = current
        logger.info(
            "TV_STATE_UPDATE user_id=%s state=%s",
            user_id,
            current,
        )
        return current

    def initialize(self, user_id: int, selected_date: Optional[str], current_view: str = "day") -> dict:
        """
        Called after pairing. Sets initial state from the web session.
        selected_date may be None — we do NOT substitute today().
        """
        state = {
            "selectedDate": selected_date,     # may be None — client must handle
            "currentView": current_view,
            "focusedEventId": None,
            "sleepGuardEnabled": True,
            "sleepGuardTimeoutMinutes": 0,
        }
        self._states[user_id] = state
        return state


# ─────────────────────────────────────────────────
# MODULE-LEVEL SINGLETONS
# ─────────────────────────────────────────────────

pairing_store = _PairingStore()
tv_state_store = _TVStateStore()

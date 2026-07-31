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
import logging
import json
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.models import AppRuntimeSecret
from app.utils.runtime_token_key_store import _seal_runtime_secret, _unseal_runtime_secret

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────

PAIRING_CODE_TTL_SECONDS = 600       # 10 minutes
# Exclude visually ambiguous glyphs so manual TV entry is reliable.
PAIRING_CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXYZ"
PAIRING_CODES_SECRET_NAME = "tv_pairing_codes_v1"


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

    @staticmethod
    def _normalize_code(raw: str) -> str:
        value = "".join(ch for ch in str(raw or "") if ch.isalnum()).upper()
        if len(value) == 8:
            return f"{value[:4]}-{value[4:]}"
        return str(raw or "").strip().upper()

    @staticmethod
    def _parse_iso(ts: str) -> Optional[datetime]:
        try:
            dt = datetime.fromisoformat(str(ts))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except Exception:
            return None

    def _load_codes_from_db(self, db: Session) -> dict:
        row = db.query(AppRuntimeSecret).filter(AppRuntimeSecret.key_name == PAIRING_CODES_SECRET_NAME).first()
        if not row or not row.secret_value:
            return {}

        try:
            payload = _unseal_runtime_secret(str(row.secret_value))
            decoded = json.loads(payload)
            if not isinstance(decoded, dict):
                return {}

            now = datetime.now(timezone.utc)
            hydrated = {}
            for code, entry in decoded.items():
                normalized_code = self._normalize_code(code)
                if not normalized_code:
                    continue
                if not isinstance(entry, dict):
                    continue
                expires_at = self._parse_iso(entry.get("expires_at"))
                if not expires_at or expires_at <= now:
                    continue
                if entry.get("used"):
                    continue
                user_id = entry.get("user_id")
                if not isinstance(user_id, int):
                    continue
                hydrated[normalized_code] = {
                    "user_id": user_id,
                    "expires_at": expires_at,
                    "used": False,
                }
            return hydrated
        except Exception as exc:
            logger.warning("TV_PAIR_STORE_LOAD_FAILED: %s", exc)
            return {}

    def _persist_codes_to_db(self, db: Session) -> None:
        try:
            serializable = {
                code: {
                    "user_id": int(entry["user_id"]),
                    "expires_at": entry["expires_at"].isoformat(),
                    "used": bool(entry.get("used", False)),
                }
                for code, entry in self._codes.items()
                if isinstance(entry, dict) and isinstance(entry.get("expires_at"), datetime)
            }
            sealed = _seal_runtime_secret(json.dumps(serializable, separators=(",", ":")))
            row = db.query(AppRuntimeSecret).filter(AppRuntimeSecret.key_name == PAIRING_CODES_SECRET_NAME).first()
            if row:
                row.secret_value = sealed
            else:
                db.add(AppRuntimeSecret(key_name=PAIRING_CODES_SECRET_NAME, secret_value=sealed))
            db.commit()
        except Exception as exc:
            db.rollback()
            logger.warning("TV_PAIR_STORE_PERSIST_FAILED: %s", exc)

    def _hydrate_from_db(self, db: Session) -> None:
        persisted = self._load_codes_from_db(db)
        if not persisted:
            return
        self._codes.update(persisted)

    # ── code generation ────────────────────────────

    def _generate_code(self) -> str:
        """ABCD-EFGH format — 8 random uppercase letters with no ambiguous glyphs."""
        raw = "".join(secrets.choice(PAIRING_CODE_ALPHABET) for _ in range(8))
        return f"{raw[:4]}-{raw[4:]}"

    def create_code(self, user_id: int, db: Session | None = None) -> dict:
        """
        Issue a new one-time pairing code for the given user.

        Returns:
            { pairingCode, expiresAt (ISO), expiresIn (seconds) }
        """
        # Purge expired codes before issuing a new one (cheap GC)
        self._purge_expired()
        if db is not None:
            self._hydrate_from_db(db)
            self._purge_expired()

        code = self._generate_code()
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=PAIRING_CODE_TTL_SECONDS)

        self._codes[code] = {
            "user_id": user_id,
            "expires_at": expires_at,
            "used": False,
        }

        logger.info("TV_PAIR_CODE_ISSUED user_id=%s code=%s", user_id, code)

        if db is not None:
            self._persist_codes_to_db(db)

        return {
            "pairingCode": code,
            "expiresAt": expires_at.isoformat(),
            "expiresIn": PAIRING_CODE_TTL_SECONDS,
        }

    def redeem_code(self, code: str, db: Session | None = None) -> Optional[int]:
        """
        Validate and consume a pairing code.

        Returns user_id on success, None on failure.
        """
        normalized_code = self._normalize_code(code)
        if db is not None:
            self._hydrate_from_db(db)
            self._purge_expired()

        entry = self._codes.get(normalized_code)

        if entry is None:
            logger.warning("TV_PAIR_INVALID_CODE code=%s", normalized_code)
            return None

        if entry["used"]:
            logger.warning("TV_PAIR_ALREADY_USED code=%s", normalized_code)
            return None

        if datetime.now(timezone.utc) > entry["expires_at"]:
            del self._codes[normalized_code]
            if db is not None:
                self._persist_codes_to_db(db)
            logger.warning("TV_PAIR_EXPIRED code=%s", normalized_code)
            return None

        # Mark consumed (one-time use)
        entry["used"] = True
        user_id = entry["user_id"]
        del self._codes[normalized_code]

        if db is not None:
            self._persist_codes_to_db(db)

        logger.info("TV_PAIR_CODE_REDEEMED user_id=%s code=%s", user_id, normalized_code)
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

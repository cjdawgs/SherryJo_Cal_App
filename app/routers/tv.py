"""
TV Mode Router
==============
Endpoints used exclusively by the Apple TV (tvOS) client.

Architecture law:
- Same backend, same APIs, same business logic as the web client
- selectedDate is the SINGLE source of truth — never defaults to today()
- TV client communicates ONLY with the backend (never with web client directly)
- ALL changes are strictly additive — no existing API contracts modified

Endpoints:
    POST  /tv/pair          — redeem a pairing code → JWT
    GET   /tv/state         — get current TV state
    PATCH /tv/state         — update TV state
    GET   /tv/events        — get UI-ready, pre-grouped events for selectedDate range
"""

import logging
import os
import json
import hashlib
import ipaddress
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field
from sqlalchemy import String, cast, func
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models import DateStickyNote, Event, OAuthAccount, Roles, TVDiagLog, User
from app.security import create_persistent_token, create_token
from app.services.tv_pairing_service import pairing_store, tv_state_store
from app.services.multi_account_oauth_service import normalize_provider
from app.utils.colors import default_account_color
from app.utils import ensure_utc, parse_iso_datetime

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tv", tags=["tv"])

# Per-user last known-good /tv/events payload cache. This is used only as a
# transient safety net during backend/read failures so the TV UI does not clear.
_tv_events_snapshot_cache: dict[int, dict] = {}

_BASE_DIR  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_templates = Jinja2Templates(directory=os.path.join(_BASE_DIR, "templates"))
_TV_BUILD_FALLBACK = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

# Same-network no-code pairing context.
# When a signed-in user generates a TV pairing code, we cache a short-lived
# auto-pair principal that LAN clients can redeem without entering the code.
_lan_autopair_ctx: dict[str, Optional[object]] = {
    "user_id": None,
    "expires_at": None,
}


def _get_tv_app_version() -> str:
    return (
        os.getenv("TV_APP_VERSION")
        or os.getenv("APP_VERSION")
        or os.getenv("RENDER_GIT_COMMIT")
        or os.getenv("SOURCE_VERSION")
        or _TV_BUILD_FALLBACK
    )


def _is_private_or_loopback_host(host: Optional[str]) -> bool:
    if not host:
        return False
    lowered = str(host).strip().lower()
    if lowered in {"localhost", "testclient"}:
        return True
    try:
        parsed = ipaddress.ip_address(lowered)
        return parsed.is_private or parsed.is_loopback
    except ValueError:
        return False


def _auto_pair_enabled() -> bool:
    raw = str(os.getenv("TV_TRUST_LAN_AUTO_PAIR", "1")).strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _mark_lan_autopair_principal(user_id: int) -> None:
    ttl_min = int(str(os.getenv("TV_LAN_AUTO_PAIR_TTL_MINUTES", "10")).strip() or "10")
    ttl_min = max(1, min(ttl_min, 120))
    _lan_autopair_ctx["user_id"] = user_id
    _lan_autopair_ctx["expires_at"] = datetime.now(timezone.utc) + timedelta(minutes=ttl_min)


def _resolve_lan_autopair_principal(request: Request) -> Optional[int]:
    if not _auto_pair_enabled():
        return None

    client_host = getattr(request.client, "host", None)
    if not _is_private_or_loopback_host(client_host):
        return None

    user_id = _lan_autopair_ctx.get("user_id")
    expires_at = _lan_autopair_ctx.get("expires_at")
    if not user_id or not isinstance(expires_at, datetime):
        return None
    if datetime.now(timezone.utc) > expires_at:
        _lan_autopair_ctx["user_id"] = None
        _lan_autopair_ctx["expires_at"] = None
        return None

    return int(user_id)


# ─────────────────────────────────────────────────
# TV DASHBOARD PAGE (no auth — JS handles token)
# ─────────────────────────────────────────────────

@router.get("/dashboard", response_class=HTMLResponse, include_in_schema=False)
def tv_dashboard(request: Request):
    """
    Serve the Apple TV dashboard shell page.
    Authentication is handled client-side: the JS reads a JWT from
    localStorage('tv_token') and uses it for all subsequent API calls.
    """
    return _templates.TemplateResponse(request, "tv.html", {
        "request": request,
        "app_version": _get_tv_app_version(),
    })


# ─────────────────────────────────────────────────
# KIOSK PAGE (for digital signage — Kitcast, etc.)
# ─────────────────────────────────────────────────

@router.get("/kiosk", response_class=HTMLResponse, include_in_schema=False)
def tv_kiosk(request: Request, token: str, db: Session = Depends(get_db)):
    """
    Digital-signage kiosk page.  The JWT is embedded in the URL query string
    so platforms like Kitcast can display the calendar with zero user interaction.

    Usage:  GET /tv/kiosk?token=<long-lived-jwt>

    The token is validated here on the server; if invalid the endpoint returns 401
    rather than serving the page (so a bad URL fails early rather than looping).
    """
    from app.security import decode_token
    try:
        payload = decode_token(token)
        user_id = payload.get("user_id")
        if not user_id:
            raise ValueError("missing user_id")
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            raise ValueError("user not found")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired kiosk token. Generate a new one from Admin.")

    return _templates.TemplateResponse(request, "tv_kiosk.html", {
        "request":     request,
        "kiosk_token": token,
        "app_version": _get_tv_app_version(),
    })


@router.get("/version")
def get_tv_version(
    current_user: User = Depends(get_current_user),
):
    return {"appVersion": _get_tv_app_version()}


@router.post("/generate-kiosk-token")
def generate_kiosk_token(
    request: Request,
    current_user: User = Depends(get_current_user),
):
    """
    Generate a persistent JWT for use in a digital-signage kiosk URL.

    Returns the token AND the full kiosk URL so the admin can paste it
    directly into Kitcast / any signage platform.
    """
    logger.info("TV_KIOSK_TOKEN_GENERATED user_id=%s", current_user.id)

    token = create_persistent_token(current_user.id)

    # Build the full URL from the incoming request so it works on
    # localhost, Render, and any custom domain without hard-coding.
    base = str(request.base_url).rstrip("/")
    kiosk_url = f"{base}/tv/kiosk?token={token}"

    return {
        "token":     token,
        "kiosk_url": kiosk_url,
        "expires_in": "persistent",
        "note": "Paste kiosk_url into your signage platform (Kitcast, etc.). No pairing or interaction needed.",
    }


# ─────────────────────────────────────────────────
# PYDANTIC SCHEMAS
# ─────────────────────────────────────────────────

class PairRequest(BaseModel):
    pairingCode: str = Field(..., min_length=9, max_length=9, pattern=r"^[A-Z0-9]{4}-[A-Z0-9]{4}$")


class PairResponse(BaseModel):
    token: str
    selectedDate: Optional[str]
    currentView: str


class TVStateResponse(BaseModel):
    selectedDate: Optional[str]
    currentView: str
    focusedEventId: Optional[int]
    currentUserEmail: Optional[str] = None
    currentUserRole: Optional[str] = None
    sleepGuardEnabled: bool = True
    sleepGuardTimeoutMinutes: int = 0


class TVStatePatch(BaseModel):
    selectedDate: Optional[str] = None
    currentView: Optional[str] = None
    focusedEventId: Optional[int] = None
    sleepGuardEnabled: Optional[bool] = None
    sleepGuardTimeoutMinutes: Optional[int] = None


class TVEventUpsert(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    date: Optional[str] = None
    start: Optional[str] = None
    end: Optional[str] = None
    durationMinutes: Optional[int] = 60


class TVStickyUpsert(BaseModel):
    sticky_notes: Optional[list[dict]] = None


class GeneratePairCodeResponse(BaseModel):
    pairingCode: str
    expiresAt: str
    expiresIn: int


# ─────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────

def _to_iso(val) -> Optional[str]:
    if not val:
        return None
    if isinstance(val, str):
        return val
    if hasattr(val, "isoformat"):
        return val.isoformat()
    return str(val)


def _is_placeholder_account_email(value: Optional[str]) -> bool:
    email = (value or "").strip().lower()
    if not email:
        return False
    if email in {"test", "test@example.com"}:
        return True
    return email.endswith("@example.com")


def _serialize_event_for_tv(event: Event) -> dict:
    """Convert a DB Event row into a TV-UI-ready dict."""
    sticky_note = getattr(event, "sticky_note", None)
    sticky_notes = getattr(event, "sticky_notes", None)
    legacy_sticky = getattr(event, "sticky", None)
    legacy_sticky_note = getattr(event, "stickyNote", None)
    related_notes = getattr(event, "notes", None)

    has_sticky_payload = (
        _sticky_payload_has_content(sticky_note)
        or _sticky_payload_has_content(sticky_notes)
        or _sticky_payload_has_content(legacy_sticky)
        or _sticky_payload_has_content(legacy_sticky_note)
    )

    has_related_notes = False
    if related_notes is not None:
        if hasattr(related_notes, "count"):
            try:
                has_related_notes = related_notes.count() > 0
            except Exception:
                has_related_notes = bool(related_notes)
        else:
            try:
                has_related_notes = len(related_notes) > 0
            except Exception:
                has_related_notes = bool(related_notes)

    has_sticky = has_sticky_payload or has_related_notes

    return {
        "id": event.id,
        "title": event.title or "",
        "start": _to_iso(event.start_time),
        "end": _to_iso(event.end_time),
        "description": event.description or "",
        "source": getattr(event, "source", "local") or "local",
        "accountEmail": getattr(event, "account_email", None),
        "color": getattr(event, "color", None),
        "hasSticky": has_sticky,
    }


def _normalize_sticky_notes(payload) -> list[dict]:
    if payload is None:
        return []

    if isinstance(payload, str):
        txt = payload.strip()
        if not txt or txt in {"[]", "{}", "null", "None"}:
            return []
        try:
            parsed = json.loads(txt)
        except Exception:
            parsed = {"content": txt}
        return _normalize_sticky_notes(parsed)

    if isinstance(payload, dict):
        normalized = _normalize_sticky_note_item(payload)
        return [normalized] if normalized else []

    if not isinstance(payload, list):
        return []

    out: list[dict] = []
    for item in payload:
        normalized = _normalize_sticky_note_item(item)
        if normalized:
            out.append(normalized)
    return out


def _extract_sticky_content(payload) -> str:
    if isinstance(payload, str):
        return payload.strip()
    if not isinstance(payload, dict):
        return ""

    for key in ("content", "text", "note", "title", "body", "message"):
        value = payload.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def _normalize_sticky_note_item(item):
    if isinstance(item, str):
        text = item.strip()
        if not text:
            return None
        now_iso = datetime.now(timezone.utc).isoformat()
        return {
            "id": f"sticky-{abs(hash(text)) % 1000000}",
            "content": text,
            "color": "#F7E68A",
            "createdAt": now_iso,
            "updatedAt": now_iso,
        }

    if not isinstance(item, dict):
        return None

    content = _extract_sticky_content(item)
    if not content:
        return None

    now_iso = datetime.now(timezone.utc).isoformat()
    return {
        "id": item.get("id") or f"sticky-{abs(hash(content)) % 1000000}",
        "content": content,
        "color": str(item.get("color") or "#F7E68A"),
        "createdAt": item.get("createdAt") or now_iso,
        "updatedAt": item.get("updatedAt") or now_iso,
    }


def _sticky_payload_has_content(payload) -> bool:
    if payload is None:
        return False

    if isinstance(payload, str):
        txt = payload.strip()
        if not txt or txt in {"[]", "{}", "null", "None"}:
            return False
        try:
            parsed = json.loads(txt)
        except Exception:
            return True
        return _sticky_payload_has_content(parsed)

    if isinstance(payload, list):
        return any(_sticky_payload_has_content(item) for item in payload)

    if isinstance(payload, dict):
        return bool(_extract_sticky_content(payload))

    return bool(payload)


def _parse_iso_date_or_none(value: Optional[str]):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value[:10]).date()
    except ValueError:
        return None


def _normalize_date_key(value) -> Optional[str]:
    """Normalize date-like values into a strict YYYY-MM-DD key."""
    if value is None:
        return None
    if hasattr(value, "date") and not isinstance(value, str):
        try:
            return value.date().isoformat()
        except Exception:
            pass
    if hasattr(value, "isoformat") and not isinstance(value, str):
        try:
            return value.isoformat()[:10]
        except Exception:
            pass

    text = str(value).strip()
    if not text:
        return None

    parsed = _parse_iso_date_or_none(text)
    if parsed is not None:
        return parsed.isoformat()

    if len(text) >= 10:
        parsed = _parse_iso_date_or_none(text[:10])
        if parsed is not None:
            return parsed.isoformat()

    return None


def _week_start_for_date(d):
    # Monday-start week grid
    return d - timedelta(days=d.weekday())


def _month_grid_start_for_date(d):
    first = d.replace(day=1)
    return _week_start_for_date(first)


def _window_for_view(anchor_date, current_view: str):
    if current_view == "day":
        # TV day mode renders a true single-day window.
        return anchor_date, anchor_date
    if current_view == "3-day":
        # Legacy TV day mode now maps to the centered 3-day strip.
        return anchor_date - timedelta(days=1), anchor_date + timedelta(days=1)
    if current_view == "week":
        start = _week_start_for_date(anchor_date)
        return start, start + timedelta(days=6)
    # month view: 6-week TV grid for stable layout
    start = _month_grid_start_for_date(anchor_date)
    return start, start + timedelta(days=41)


def _group_events_by_date(events: list[Event]) -> list[dict]:
    """
    Group events into UI-ready day buckets.

    Returns:
        [
          { "date": "YYYY-MM-DD", "events": [...] },
          ...
        ]
    sorted ascending by date.
    """
    buckets: dict[str, list] = defaultdict(list)

    for event in events:
        start = ensure_utc(getattr(event, "start_time", None))
        if not start:
            continue

        date_key = start.date().isoformat()
        buckets[date_key].append(_serialize_event_for_tv(event))

    return [
        {"date": date_key, "events": buckets[date_key]}
        for date_key in sorted(buckets.keys())
    ]


def _events_in_window(events: list[Event], start: datetime, end: datetime) -> list[Event]:
    """Fallback in-memory filtering when DB datetime comparisons fail."""
    in_range: list[tuple[datetime, Event]] = []
    for event in events:
        event_start = ensure_utc(getattr(event, "start_time", None))
        if event_start and start <= event_start <= end:
            in_range.append((event_start, event))
    in_range.sort(key=lambda pair: pair[0])
    return [pair[1] for pair in in_range]


def _sticky_owner_filter(user_id: int):
    """Handle legacy schemas where date_sticky_notes.owner_id may be text."""
    return cast(DateStickyNote.owner_id, String) == str(user_id)


def _event_owner_filter(user_id: int):
    """Handle legacy schemas where events.owner_id may be text."""
    return cast(Event.owner_id, String) == str(user_id)


def _oauth_user_filter(user_id: int):
    """Handle legacy schemas where oauth_accounts.user_id may be text."""
    return cast(OAuthAccount.user_id, String) == str(user_id)


def _build_tv_events_fast_etag(
    db: Session,
    user_id: int,
    selected_date_str: str,
    current_view: str,
    window_start: datetime,
    window_end: datetime,
    start_key: str,
    end_key: str,
) -> str:
    """
    Build a cheap change fingerprint for /tv/events.

    This avoids full payload materialization on unchanged data and allows the
    endpoint to return 304 quickly. The fingerprint is based on row counts and
    max(updated_at) markers across events, sticky notes, and account metadata.
    """
    event_count, event_max_updated = (
        db.query(
            func.count(Event.id),
            func.max(Event.updated_at),
        )
        .filter(
            _event_owner_filter(user_id),
            Event.start_time >= window_start,
            Event.start_time <= window_end,
        )
        .one()
    )

    sticky_count, sticky_max_updated = (
        db.query(
            func.count(DateStickyNote.id),
            func.max(DateStickyNote.updated_at),
        )
        .filter(
            _sticky_owner_filter(user_id),
            DateStickyNote.date >= start_key,
            DateStickyNote.date <= end_key,
        )
        .one()
    )

    account_count, account_max_updated = (
        db.query(
            func.count(OAuthAccount.id),
            func.max(OAuthAccount.updated_at),
        )
        .filter(
            _oauth_user_filter(user_id),
            OAuthAccount.sync_enabled.is_(True),
        )
        .one()
    )

    marker = {
        "v": 1,
        "selectedDate": selected_date_str,
        "currentView": current_view,
        "rangeStart": start_key,
        "rangeEnd": end_key,
        "events": {
            "count": int(event_count or 0),
            "maxUpdated": _to_iso(event_max_updated),
        },
        "sticky": {
            "count": int(sticky_count or 0),
            "maxUpdated": _to_iso(sticky_max_updated),
        },
        "accounts": {
            "count": int(account_count or 0),
            "maxUpdated": _to_iso(account_max_updated),
        },
    }

    digest = hashlib.sha256(
        json.dumps(marker, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    ).hexdigest()
    return f'W/"{digest}"'


# ─────────────────────────────────────────────────
# DIAGNOSTICS  (ring-buffer log of TV lifecycle events)
# ─────────────────────────────────────────────────

# In-memory ring buffer.  Max 500 entries; cleared when the server restarts.
_diag_buffer: list[dict] = []
_DIAG_MAX = 500
_DIAG_QUERY_MAX = 100
_DIAG_WINDOW_MAX_HOURS = 24 * 30
REPAIR_RISK_DIAG_EVENTS = frozenset({
    "token_invalid_401",
    "kiosk_token_invalid_401",
    "storage_token_removed",
    "user_unpair_requested",
})


class TVDiagEntry(BaseModel):
    event:             str
    details:           Optional[str] = ""
    ts:                Optional[str] = None       # ISO timestamp from client
    sessionElapsedMin: Optional[int] = None
    visibilityState:   Optional[str] = None
    guardEnabled:      Optional[bool] = None
    guardTimeout:      Optional[int] = None
    device_id:         Optional[str] = None       # stable UUID from localStorage


class TVDiagBatch(BaseModel):
    """Batched beacon. The client flushes several entries in one request."""
    entries: list[TVDiagEntry] = Field(max_length=50)


# A TV kiosk runs 24/7, so anything it repeats on a timer must not become a
# permanent row. Routine liveness events are kept in memory and persisted at
# most once per device per interval; everything else (session lifecycle,
# renderer stalls, freezes) is persisted immediately because it is why the
# table exists.
ROUTINE_DIAG_EVENTS = frozenset({"heartbeat", "poll", "tick"})


def _diag_persistence_enabled() -> bool:
    return (os.getenv("TV_DIAG_PERSIST", "1") or "").strip().lower() not in {"0", "false", "no", "off"}


def _routine_persist_interval() -> timedelta:
    try:
        minutes = int(os.getenv("TV_DIAG_ROUTINE_PERSIST_MINUTES", "60"))
    except ValueError:
        minutes = 60
    return timedelta(minutes=max(1, minutes))


# device_id -> last time a routine event from that device was written to the DB.
_routine_persist_seen: dict[str, datetime] = {}


def _should_persist(event: str, device_id: str) -> bool:
    if not _diag_persistence_enabled():
        return False
    if event not in ROUTINE_DIAG_EVENTS:
        return True

    now = datetime.now(timezone.utc)
    key = device_id or "unknown"
    last = _routine_persist_seen.get(key)
    if last and now - last < _routine_persist_interval():
        return False
    _routine_persist_seen[key] = now
    return True


def _record_diag_entry(body: TVDiagEntry, user_id: int, ua: str, db: Session) -> None:
    global _diag_buffer
    entry = {
        "ts_server":      datetime.now(timezone.utc).isoformat(),
        "user_id":        user_id,
        "device_id":      (body.device_id or "")[:64],
        "device_ua":      ua,
        "event":          (body.event or "")[:64],
        "details":        (body.details or "")[:256],
        "ts_client":      (body.ts or "")[:32],
        "elapsed_min":    body.sessionElapsedMin,
        "visibility":     body.visibilityState,
        "guard_enabled":  body.guardEnabled,
        "guard_timeout":  body.guardTimeout,
    }
    # Memory ring buffer (fast, for live admin panel display)
    _diag_buffer.append(entry)
    if len(_diag_buffer) > _DIAG_MAX:
        del _diag_buffer[:-_DIAG_MAX]

    if not _should_persist(entry["event"], entry["device_id"]):
        return

    db.add(TVDiagLog(
        user_id       = user_id,
        device_id     = entry["device_id"] or None,
        device_ua     = ua or None,
        event         = entry["event"],
        details       = entry["details"] or None,
        ts_client     = entry["ts_client"] or None,
        elapsed_min   = entry["elapsed_min"],
        visibility    = entry["visibility"],
        guard_enabled = entry["guard_enabled"],
        guard_timeout = entry["guard_timeout"],
    ))


@router.post("/diag", status_code=200)
def post_tv_diag(
    body: TVDiagEntry | TVDiagBatch,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Receives diagnostic events beaconed by the TV dashboard JS, either singly
    (legacy clients) or as a batch. Fire-and-forget from the client — uses
    fetch keepalive so it survives page unload. Never blocks the TV UI.

    Entries always land in the in-memory ring buffer. They reach the
    tv_diag_log table only when they carry signal: see ``_should_persist``.
    """
    ua = (request.headers.get("user-agent") or "")[:512]
    entries = body.entries if isinstance(body, TVDiagBatch) else [body]

    for item in entries:
        _record_diag_entry(item, current_user.id, ua, db)

    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.warning("TV_DIAG db write failed (memory buffer still updated): %s", exc)

    logger.debug("TV_DIAG user_id=%s entries=%s", current_user.id, len(entries))
    return {"ok": True, "accepted": len(entries)}


@router.get("/diag")
def get_tv_diag(
    scope: str = "own",
    hours: Optional[int] = None,
    event_group: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Returns the last 100 diagnostic entries (most-recent first).
    Reads from Supabase/Postgres so it reflects all of the caller's devices and
    survives restarts.  Falls back to the in-memory buffer if the DB is
    unavailable.

    Entries are scoped to the caller.  Admins may pass ``scope=all`` for the
    fleet-wide view; diagnostics carry device IDs and user agents, so they are
    not shared between users.
    """
    fleet_wide = scope == "all"
    normalized_event_group = (event_group or "").strip().lower()
    if normalized_event_group in {"", "all"}:
        normalized_event_group = "all"
        selected_events = None
    elif normalized_event_group == "repair_risk":
        selected_events = REPAIR_RISK_DIAG_EVENTS
    else:
        raise HTTPException(status_code=400, detail="Unsupported event_group")

    bounded_hours: Optional[int] = None
    window_start: Optional[datetime] = None
    if hours is not None:
        bounded_hours = max(1, min(int(hours), _DIAG_WINDOW_MAX_HOURS))
        window_start = datetime.now(timezone.utc) - timedelta(hours=bounded_hours)

    if fleet_wide and current_user.role != Roles.ADMIN:
        raise HTTPException(status_code=403, detail="Admin only")

    try:
        query = db.query(TVDiagLog)
        if not fleet_wide:
            query = query.filter(TVDiagLog.user_id == current_user.id)
        if window_start is not None:
            query = query.filter(TVDiagLog.ts_server >= window_start)
        if selected_events is not None:
            query = query.filter(TVDiagLog.event.in_(tuple(selected_events)))

        rows = (
            query
            .order_by(TVDiagLog.ts_server.desc())
            .limit(_DIAG_QUERY_MAX)
            .all()
        )
        entries = [
            {
                "ts_server":    r.ts_server.isoformat() if r.ts_server else None,
                "user_id":      r.user_id,
                "device_id":    r.device_id or "",
                "device_ua":    r.device_ua or "",
                "event":        r.event,
                "details":      r.details or "",
                "ts_client":    r.ts_client or "",
                "elapsed_min":  r.elapsed_min,
                "visibility":   r.visibility or "",
                "guard_enabled": r.guard_enabled,
                "guard_timeout": r.guard_timeout,
            }
            for r in rows
        ]
        return {
            "entries": entries,
            "scope": scope if fleet_wide else "own",
            "source": "db",
            "filters": {
                "hours": bounded_hours,
                "event_group": normalized_event_group,
            },
        }
    except Exception as exc:
        logger.warning("TV_DIAG db read failed, falling back to memory buffer: %s", exc)
        buffered = [
            entry
            for entry in reversed(_diag_buffer[-500:])
            if fleet_wide or entry.get("user_id") == current_user.id
        ]
        if window_start is not None:
            filtered_by_time = []
            for entry in buffered:
                ts_server = parse_iso_datetime(entry.get("ts_server"))
                if ts_server and ts_server >= window_start:
                    filtered_by_time.append(entry)
            buffered = filtered_by_time
        if selected_events is not None:
            buffered = [
                entry for entry in buffered
                if str(entry.get("event") or "") in selected_events
            ]
        buffered = buffered[:_DIAG_QUERY_MAX]
        return {
            "entries": buffered,
            "scope": scope if fleet_wide else "own",
            "source": "memory",
            "filters": {
                "hours": bounded_hours,
                "event_group": normalized_event_group,
            },
        }


# ─────────────────────────────────────────────────
# PHASE 2 — PAIRING
# ─────────────────────────────────────────────────

@router.post("/generate-code", response_model=GeneratePairCodeResponse)
def generate_pairing_code(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Admin/user calls this from the web UI to produce a time-limited pairing code
    that an Apple TV can use to authenticate.

    Logs: TV_PAIR_REQUEST
    """
    logger.info("TV_PAIR_REQUEST user_id=%s", current_user.id)

    result = pairing_store.create_code(current_user.id, db=db)
    _mark_lan_autopair_principal(current_user.id)
    return result


@router.post("/pair", response_model=PairResponse)
def pair_tv(
    body: PairRequest,
    db: Session = Depends(get_db),
):
    """
    Apple TV calls this with the code shown on the web UI.
    Returns a JWT valid for TV interactions and the current TV state.

    One-time use, TTL ≤ 10 minutes.
    Logs: TV_PAIR_REQUEST
    """
    logger.info("TV_PAIR_REQUEST code=%s", body.pairingCode)

    user_id = pairing_store.redeem_code(body.pairingCode, db=db)
    if user_id is None:
        raise HTTPException(status_code=400, detail="Invalid or expired pairing code")

    # Ensure user still exists
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    # Initialize TV state (inherits any existing web state; selectedDate may be None)
    existing_state = tv_state_store.get(user_id)
    if not existing_state:
        tv_state_store.initialize(user_id, selected_date=None, current_view="day")
    state = tv_state_store.get(user_id)

    # Issue a persistent TV token so the device stays paired until it is
    # explicitly unpaired or the signing secret is rotated.
    token = create_persistent_token(user_id)

    return {
        "token": token,
        "selectedDate": state.get("selectedDate"),
        "currentView": state.get("currentView", "day"),
    }


@router.post("/auto-pair", response_model=PairResponse)
def auto_pair_tv(
    request: Request,
    db: Session = Depends(get_db),
):
    """
    Same-network convenience path:
    - Requires a recent authenticated /tv/generate-code call (short-lived principal)
    - Accepts only loopback/private-network client addresses
    - Issues the same persistent TV token as manual pairing
    """
    user_id = _resolve_lan_autopair_principal(request)
    if user_id is None:
        raise HTTPException(status_code=404, detail="Auto-pair unavailable")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    existing_state = tv_state_store.get(user_id)
    if not existing_state:
        tv_state_store.initialize(user_id, selected_date=None, current_view="day")
    state = tv_state_store.get(user_id)

    token = create_persistent_token(user_id)
    logger.info("TV_AUTO_PAIR_SUCCESS user_id=%s host=%s", user_id, getattr(request.client, "host", "?"))

    return {
        "token": token,
        "selectedDate": state.get("selectedDate"),
        "currentView": state.get("currentView", "day"),
    }


# ─────────────────────────────────────────────────
# PHASE 3 — GLOBAL STATE
# ─────────────────────────────────────────────────

@router.get("/state", response_model=TVStateResponse)
def get_tv_state(
    current_user: User = Depends(get_current_user),
):
    """
    Returns the current TV state for the authenticated user.

    selectedDate is never substituted with today() — clients must handle None.
    Logs: (read-only, no special log needed)
    """
    state = tv_state_store.get(current_user.id)
    if state is None:
        # Return empty state — do NOT inject today()
        return TVStateResponse(
            selectedDate=None,
            currentView="day",
            focusedEventId=None,
            currentUserEmail=current_user.email,
            currentUserRole=current_user.role,
            sleepGuardEnabled=True,
            sleepGuardTimeoutMinutes=0,
        )
    return TVStateResponse(
        selectedDate=state.get("selectedDate"),
        currentView=state.get("currentView", "day"),
        focusedEventId=state.get("focusedEventId"),
        currentUserEmail=current_user.email,
        currentUserRole=current_user.role,
        sleepGuardEnabled=state.get("sleepGuardEnabled", True),
        sleepGuardTimeoutMinutes=state.get("sleepGuardTimeoutMinutes", 0),
    )


@router.patch("/state", response_model=TVStateResponse)
def patch_tv_state(
    body: TVStatePatch,
    current_user: User = Depends(get_current_user),
):
    """
    Apple TV (or web UI) patches the shared TV state.

    Only provided fields are updated; omitted fields are unchanged.
    Logs: TV_STATE_UPDATE
    """
    patch = body.model_dump(exclude_none=True)
    updated = tv_state_store.set(current_user.id, patch)
    if patch:
        _tv_events_snapshot_cache.pop(current_user.id, None)

    return TVStateResponse(
        selectedDate=updated.get("selectedDate"),
        currentView=updated.get("currentView", "day"),
        focusedEventId=updated.get("focusedEventId"),
        currentUserEmail=current_user.email,
        currentUserRole=current_user.role,
        sleepGuardEnabled=updated.get("sleepGuardEnabled", True),
        sleepGuardTimeoutMinutes=updated.get("sleepGuardTimeoutMinutes", 0),
    )


# ─────────────────────────────────────────────────
# PHASE 4 — EVENT NORMALIZATION
# ─────────────────────────────────────────────────

@router.get("/events")
def get_tv_events(
    request: Request,
    selectedDate: Optional[str] = None,
    currentView: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Returns UI-ready, pre-grouped events for the TV client.

    Uses selectedDate and currentView from TV state to compute a TV layout window.
    If selectedDate is not set, returns an empty result — never defaults to today().

    Response shape:
                {
                    "selectedDate": "...",
                    "currentView": "day|3-day|week|month",
                    "rangeStart": "YYYY-MM-DD",
                    "rangeEnd": "YYYY-MM-DD",
                    "days": [ { "date": "...", "events": [...], "stickyNotes": [...] } ]
                }

    Logs: TV_EVENTS_FETCH
    """
    logger.info("TV_EVENTS_FETCH user_id=%s", current_user.id)

    app_version = _get_tv_app_version()
    state = tv_state_store.get(current_user.id)
    selected_date_str: Optional[str] = (selectedDate or "").strip() or None
    if selected_date_str is None:
        selected_date_str = state.get("selectedDate") if state else None

    requested_view = (currentView or "").strip().lower()
    if requested_view in {"day", "3-day", "week", "month"}:
        current_view = requested_view
    else:
        current_view = (state.get("currentView") if state else None) or "day"

    if not selected_date_str:
        # Do NOT default to today — return empty, let client decide
        return JSONResponse(
            content={"selectedDate": None, "currentView": current_view, "days": [], "appVersion": app_version},
            headers={"Cache-Control": "no-store", "X-TV-App-Version": app_version},
        )

    anchor_date = _parse_iso_date_or_none(selected_date_str)
    if anchor_date is None:
        raise HTTPException(status_code=400, detail="selectedDate in state is not a valid ISO date")

    try:
        window_start_date, window_end_date = _window_for_view(anchor_date, current_view)
        window_start = datetime.combine(window_start_date, datetime.min.time()).replace(tzinfo=timezone.utc)
        window_end = datetime.combine(window_end_date, datetime.max.time()).replace(tzinfo=timezone.utc)
        start_key = window_start_date.isoformat()
        end_key = window_end_date.isoformat()

        fast_etag = None
        try:
            fast_etag = _build_tv_events_fast_etag(
                db=db,
                user_id=current_user.id,
                selected_date_str=selected_date_str,
                current_view=current_view,
                window_start=window_start,
                window_end=window_end,
                start_key=start_key,
                end_key=end_key,
            )
            if request.headers.get("if-none-match") == fast_etag:
                return Response(
                    status_code=304,
                    headers={
                        "ETag": fast_etag,
                        "Cache-Control": "no-store",
                        "X-TV-App-Version": app_version,
                    },
                )
        except SQLAlchemyError:
            logger.exception(
                "TV_EVENTS_FAST_ETAG_FAILED user_id=%s; continuing with full payload",
                current_user.id,
            )

        try:
            events = (
                db.query(Event)
                .filter(
                    _event_owner_filter(current_user.id),
                    Event.start_time >= window_start,
                    Event.start_time <= window_end,
                )
                .order_by(Event.start_time)
                .all()
            )
        except SQLAlchemyError:
            logger.exception(
                "TV_EVENTS_FETCH_DB_WINDOW_QUERY_FAILED user_id=%s; falling back to Python filtering",
                current_user.id,
            )
            try:
                all_events = db.query(Event).filter(_event_owner_filter(current_user.id)).all()
                events = _events_in_window(all_events, window_start, window_end)
            except SQLAlchemyError:
                logger.exception(
                    "TV_EVENTS_FETCH_DB_ALL_EVENTS_FAILED user_id=%s; using empty events",
                    current_user.id,
                )
                events = []

        by_date_events = {day["date"]: day["events"] for day in _group_events_by_date(events)}
        try:
            sticky_rows = (
                db.query(DateStickyNote)
                .filter(
                    _sticky_owner_filter(current_user.id),
                    DateStickyNote.date >= start_key,
                    DateStickyNote.date <= end_key,
                )
                .all()
            )
        except SQLAlchemyError:
            logger.exception(
                "TV_EVENTS_FETCH_STICKY_QUERY_FAILED user_id=%s; falling back to Python filtering",
                current_user.id,
            )
            try:
                sticky_rows = [
                    row for row in db.query(DateStickyNote).filter(_sticky_owner_filter(current_user.id)).all()
                    if (_normalize_date_key(getattr(row, "date", None)) or "") >= start_key
                    and (_normalize_date_key(getattr(row, "date", None)) or "") <= end_key
                ]
            except SQLAlchemyError:
                logger.exception(
                    "TV_EVENTS_FETCH_STICKY_FALLBACK_FAILED user_id=%s; using empty sticky notes",
                    current_user.id,
                )
                sticky_rows = []

        sticky_map = {}
        for row in sticky_rows:
            date_key = _normalize_date_key(getattr(row, "date", None))
            if not date_key:
                continue
            sticky_map[date_key] = _normalize_sticky_notes(getattr(row, "sticky_notes", None))

        days = []
        cursor = window_start_date
        while cursor <= window_end_date:
            key = cursor.isoformat()
            days.append({
                "date": key,
                "events": by_date_events.get(key, []),
                "stickyNotes": sticky_map.get(key, []),
            })
            cursor = cursor + timedelta(days=1)

        accounts = []
        try:
            account_rows = (
                db.query(OAuthAccount)
                .filter(_oauth_user_filter(current_user.id), OAuthAccount.sync_enabled.is_(True))
                .all()
            )
            seen = set()
            for acc in account_rows:
                if _is_placeholder_account_email(acc.account_email):
                    continue
                provider = normalize_provider(acc.provider or "local")
                account_email = (acc.account_email or "").strip().lower()
                dedupe_key = (provider, account_email)
                account_key = f"{provider}:{account_email or provider}"
                color = acc.color or default_account_color(provider)
                key = dedupe_key
                if key in seen:
                    continue
                seen.add(key)
                accounts.append({
                    "provider": provider,
                    "accountEmail": account_email,
                    "account_key": account_key,
                    "color": color,
                })
        except SQLAlchemyError:
            logger.exception("TV_EVENTS_FETCH_ACCOUNTS_QUERY_FAILED user_id=%s; omitting account legend metadata", current_user.id)

        event_count = sum(len(day.get("events", [])) for day in days)
        sticky_count = sum(len(day.get("stickyNotes", [])) for day in days)
        account_count = len(accounts)

        logger.info(
            "TV_EVENTS_FETCH_RESULT user_id=%s selected_date=%s view=%s range=%s..%s day_count=%s event_count=%s sticky_count=%s account_count=%s",
            current_user.id,
            selected_date_str,
            current_view,
            start_key,
            end_key,
            len(days),
            event_count,
            sticky_count,
            account_count,
        )

        payload = {
            "selectedDate": selected_date_str,
            "currentView": current_view,
            "rangeStart": window_start_date.isoformat(),
            "rangeEnd": window_end_date.isoformat(),
            "appVersion": app_version,
            "days": days,
            "accounts": accounts,
            "summary": {
                "eventCount": event_count,
                "stickyCount": sticky_count,
                "accountCount": account_count,
            },
            "staleData": False,
        }

        payload_etag = fast_etag or f'W/"{hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")).hexdigest()}"'
        if request.headers.get("if-none-match") == payload_etag:
            return Response(status_code=304, headers={"ETag": payload_etag, "Cache-Control": "no-store", "X-TV-App-Version": app_version})

        _tv_events_snapshot_cache[current_user.id] = payload
        return JSONResponse(content=payload, headers={"ETag": payload_etag, "Cache-Control": "no-store", "X-TV-App-Version": app_version})
    except Exception:
        logger.exception("TV_EVENTS_FETCH_UNEXPECTED_FAILURE user_id=%s", current_user.id)
        cached = _tv_events_snapshot_cache.get(current_user.id)
        if isinstance(cached, dict) and cached.get("days") is not None:
            # Return last known-good payload instead of emptying the TV board.
            fallback = dict(cached)
            fallback["staleData"] = True
            fallback["staleReason"] = "backend_refresh_failure"
            fallback["appVersion"] = app_version
            return JSONResponse(content=fallback, headers={"Cache-Control": "no-store", "X-TV-App-Version": app_version})

        # No safe snapshot yet; keep shape explicit for client-side guards.
        return JSONResponse(content={
            "selectedDate": selected_date_str,
            "currentView": current_view,
            "days": [],
            "staleData": True,
            "staleReason": "backend_refresh_failure_no_snapshot",
            "appVersion": app_version,
        }, headers={"Cache-Control": "no-store", "X-TV-App-Version": app_version})


@router.post("/events")
def create_tv_event(
    body: TVEventUpsert,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    state = tv_state_store.get(current_user.id) or {}
    selected_date = body.date or state.get("selectedDate")
    date_obj = _parse_iso_date_or_none(selected_date)
    if not date_obj:
        raise HTTPException(status_code=422, detail="selectedDate is required to create an event")

    now_utc = datetime.now(timezone.utc)
    start_dt = parse_iso_datetime(body.start)
    if start_dt is None:
        start_dt = datetime.combine(date_obj, datetime.min.time()).replace(tzinfo=timezone.utc) + timedelta(hours=9)

    end_dt = parse_iso_datetime(body.end)
    if end_dt is None:
        end_dt = start_dt + timedelta(minutes=max(15, int(body.durationMinutes or 60)))

    event = Event(
        title=(body.title or "New Event").strip() or "New Event",
        description=(body.description or "").strip(),
        start_time=start_dt,
        end_time=end_dt,
        owner_id=current_user.id,
        source="local",
        account_email="local",
        created_at=now_utc,
        updated_at=now_utc,
    )
    db.add(event)
    db.commit()
    db.refresh(event)

    tv_state_store.set(current_user.id, {"focusedEventId": event.id})

    return {"status": "ok", "event": _serialize_event_for_tv(event)}


@router.put("/events/{event_id}")
def update_tv_event(
    event_id: int,
    body: TVEventUpsert,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    event = (
        db.query(Event)
        .filter(Event.id == event_id, Event.owner_id == current_user.id)
        .first()
    )
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    if body.title is not None:
        title = body.title.strip()
        if not title:
            raise HTTPException(status_code=422, detail="title cannot be empty")
        event.title = title

    if body.description is not None:
        event.description = body.description.strip()

    if body.start is not None:
        start_dt = parse_iso_datetime(body.start)
        if start_dt is None:
            raise HTTPException(status_code=422, detail="start is invalid")
        event.start_time = start_dt

    if body.end is not None:
        end_dt = parse_iso_datetime(body.end)
        if body.end and end_dt is None:
            raise HTTPException(status_code=422, detail="end is invalid")
        event.end_time = end_dt

    event.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(event)
    return {"status": "ok", "event": _serialize_event_for_tv(event)}


@router.put("/date-sticky/{date_key}")
def upsert_tv_date_sticky(
    date_key: str,
    body: TVStickyUpsert,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    date_obj = _parse_iso_date_or_none(date_key)
    if date_obj is None:
        raise HTTPException(status_code=422, detail="date_key must be YYYY-MM-DD")

    sticky_notes = _normalize_sticky_notes(body.sticky_notes)

    row = (
        db.query(DateStickyNote)
        .filter(
            _sticky_owner_filter(current_user.id),
            DateStickyNote.date == date_obj.isoformat(),
        )
        .first()
    )

    if not sticky_notes:
        if row:
            db.delete(row)
            db.commit()
        return {"status": "ok", "item": {"date": date_obj.isoformat(), "sticky_notes": [], "count": 0}}

    if not row:
        row = DateStickyNote(
            owner_id=current_user.id,
            date=date_obj.isoformat(),
            sticky_notes=sticky_notes,
        )
        db.add(row)
    else:
        row.sticky_notes = sticky_notes
        row.updated_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(row)
    return {
        "status": "ok",
        "item": {
            "date": row.date,
            "sticky_notes": _normalize_sticky_notes(row.sticky_notes),
            "count": len(_normalize_sticky_notes(row.sticky_notes)),
        },
    }


@router.delete("/date-sticky/{date_key}")
def delete_tv_date_sticky(
    date_key: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    row = (
        db.query(DateStickyNote)
        .filter(
            _sticky_owner_filter(current_user.id),
            DateStickyNote.date == date_key,
        )
        .first()
    )
    if row:
        db.delete(row)
        db.commit()
    return {"status": "ok", "deleted": date_key}

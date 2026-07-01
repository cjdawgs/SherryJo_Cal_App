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
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field
from sqlalchemy import String, cast
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models import DateStickyNote, Event, OAuthAccount, User
from app.security import create_token
from app.services.tv_pairing_service import pairing_store, tv_state_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tv", tags=["tv"])

_BASE_DIR  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_templates = Jinja2Templates(directory=os.path.join(_BASE_DIR, "templates"))


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
    return _templates.TemplateResponse(request, "tv.html", {"request": request})


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
    })


@router.post("/generate-kiosk-token")
def generate_kiosk_token(
    request: Request,
    current_user: User = Depends(get_current_user),
):
    """
    Generate a 1-year JWT for use in a digital-signage kiosk URL.

    Returns the token AND the full kiosk URL so the admin can paste it
    directly into Kitcast / any signage platform.
    """
    logger.info("TV_KIOSK_TOKEN_GENERATED user_id=%s", current_user.id)

    # 1 year = 525 960 minutes
    token = create_token(current_user.id, minutes=525_960)

    # Build the full URL from the incoming request so it works on
    # localhost, Render, and any custom domain without hard-coding.
    base = str(request.base_url).rstrip("/")
    kiosk_url = f"{base}/tv/kiosk?token={token}"

    return {
        "token":     token,
        "kiosk_url": kiosk_url,
        "expires_in": "1 year",
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


class TVStatePatch(BaseModel):
    selectedDate: Optional[str] = None
    currentView: Optional[str] = None
    focusedEventId: Optional[int] = None


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


def _serialize_event_for_tv(event: Event) -> dict:
    """Convert a DB Event row into a TV-UI-ready dict."""
    sticky_note = getattr(event, "sticky_note", None)
    sticky_notes = getattr(event, "sticky_notes", None)
    has_sticky = bool(sticky_note) or (isinstance(sticky_notes, list) and len(sticky_notes) > 0)

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

    if isinstance(payload, dict):
        payload = [payload]

    if not isinstance(payload, list):
        return []

    out: list[dict] = []
    now_iso = datetime.now(timezone.utc).isoformat()
    for item in payload:
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or "").strip()
        if not content:
            continue
        out.append({
            "id": item.get("id") or f"sticky-{len(out) + 1}",
            "content": content,
            "color": str(item.get("color") or "#F7E68A"),
            "createdAt": item.get("createdAt") or now_iso,
            "updatedAt": now_iso,
        })
    return out


def _parse_iso_datetime_or_none(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _coerce_datetime_utc(value) -> Optional[datetime]:
    """Best-effort conversion into aware UTC datetimes for legacy DB rows."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        return _parse_iso_datetime_or_none(value)
    return None


def _parse_iso_date_or_none(value: Optional[str]):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value[:10]).date()
    except ValueError:
        return None


def _week_start_for_date(d):
    # Monday-start week grid
    return d - timedelta(days=d.weekday())


def _month_grid_start_for_date(d):
    first = d.replace(day=1)
    return _week_start_for_date(first)


def _window_for_view(anchor_date, current_view: str):
    if current_view == "day":
        # TV day mode renders a centered 3-day strip: previous, selected, next.
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
        start = _coerce_datetime_utc(getattr(event, "start_time", None))
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
        event_start = _coerce_datetime_utc(getattr(event, "start_time", None))
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


# ─────────────────────────────────────────────────
# PHASE 2 — PAIRING
# ─────────────────────────────────────────────────

@router.post("/generate-code", response_model=GeneratePairCodeResponse)
def generate_pairing_code(
    current_user: User = Depends(get_current_user),
):
    """
    Admin/user calls this from the web UI to produce a time-limited pairing code
    that an Apple TV can use to authenticate.

    Logs: TV_PAIR_REQUEST
    """
    logger.info("TV_PAIR_REQUEST user_id=%s", current_user.id)

    result = pairing_store.create_code(current_user.id)
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

    user_id = pairing_store.redeem_code(body.pairingCode)
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

    # Issue a long-lived TV token (8 hours)
    token = create_token(user_id, minutes=480)

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
        )
    return TVStateResponse(
        selectedDate=state.get("selectedDate"),
        currentView=state.get("currentView", "day"),
        focusedEventId=state.get("focusedEventId"),
        currentUserEmail=current_user.email,
        currentUserRole=current_user.role,
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

    return TVStateResponse(
        selectedDate=updated.get("selectedDate"),
        currentView=updated.get("currentView", "day"),
        focusedEventId=updated.get("focusedEventId"),
        currentUserEmail=current_user.email,
        currentUserRole=current_user.role,
    )


# ─────────────────────────────────────────────────
# PHASE 4 — EVENT NORMALIZATION
# ─────────────────────────────────────────────────

@router.get("/events")
def get_tv_events(
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
                    "currentView": "day|week|month",
                    "rangeStart": "YYYY-MM-DD",
                    "rangeEnd": "YYYY-MM-DD",
                    "days": [ { "date": "...", "events": [...], "stickyNotes": [...] } ]
                }

    Logs: TV_EVENTS_FETCH
    """
    logger.info("TV_EVENTS_FETCH user_id=%s", current_user.id)

    state = tv_state_store.get(current_user.id)
    selected_date_str: Optional[str] = state.get("selectedDate") if state else None
    current_view = (state.get("currentView") if state else None) or "day"

    if not selected_date_str:
        # Do NOT default to today — return empty, let client decide
        return {"selectedDate": None, "currentView": current_view, "days": []}

    anchor_date = _parse_iso_date_or_none(selected_date_str)
    if anchor_date is None:
        raise HTTPException(status_code=400, detail="selectedDate in state is not a valid ISO date")

    try:
        window_start_date, window_end_date = _window_for_view(anchor_date, current_view)
        window_start = datetime.combine(window_start_date, datetime.min.time()).replace(tzinfo=timezone.utc)
        window_end = datetime.combine(window_end_date, datetime.max.time()).replace(tzinfo=timezone.utc)

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

        start_key = window_start_date.isoformat()
        end_key = window_end_date.isoformat()
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
                    if isinstance(getattr(row, "date", None), str) and start_key <= row.date <= end_key
                ]
            except SQLAlchemyError:
                logger.exception(
                    "TV_EVENTS_FETCH_STICKY_FALLBACK_FAILED user_id=%s; using empty sticky notes",
                    current_user.id,
                )
                sticky_rows = []

        sticky_map = {
            row.date: _normalize_sticky_notes(getattr(row, "sticky_notes", None))
            for row in sticky_rows
            if isinstance(getattr(row, "date", None), str)
        }

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
                key = (acc.provider or "", acc.account_email or "")
                if key in seen:
                    continue
                seen.add(key)
                accounts.append({
                    "provider": acc.provider or "local",
                    "accountEmail": acc.account_email or "",
                    "color": acc.color,
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

        return {
            "selectedDate": selected_date_str,
            "currentView": current_view,
            "rangeStart": window_start_date.isoformat(),
            "rangeEnd": window_end_date.isoformat(),
            "days": days,
            "accounts": accounts,
            "summary": {
                "eventCount": event_count,
                "stickyCount": sticky_count,
                "accountCount": account_count,
            },
        }
    except Exception:
        logger.exception("TV_EVENTS_FETCH_UNEXPECTED_FAILURE user_id=%s", current_user.id)
        # Keep TV UI alive in production even if data layer is unhealthy.
        return {
            "selectedDate": selected_date_str,
            "currentView": current_view,
            "days": [],
        }


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
    start_dt = _parse_iso_datetime_or_none(body.start)
    if start_dt is None:
        start_dt = datetime.combine(date_obj, datetime.min.time()).replace(tzinfo=timezone.utc) + timedelta(hours=9)

    end_dt = _parse_iso_datetime_or_none(body.end)
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
        start_dt = _parse_iso_datetime_or_none(body.start)
        if start_dt is None:
            raise HTTPException(status_code=422, detail="start is invalid")
        event.start_time = start_dt

    if body.end is not None:
        end_dt = _parse_iso_datetime_or_none(body.end)
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

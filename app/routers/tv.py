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
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models import Event, User
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


class TVStatePatch(BaseModel):
    selectedDate: Optional[str] = None
    currentView: Optional[str] = None
    focusedEventId: Optional[int] = None


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
    return {
        "id": event.id,
        "title": event.title or "",
        "start": _to_iso(event.start_time),
        "end": _to_iso(event.end_time),
        "description": event.description or "",
        "source": getattr(event, "source", "local") or "local",
        "color": getattr(event, "color", None),
    }


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
        if not event.start_time:
            continue
        # Normalise to aware datetime
        start = event.start_time
        if hasattr(start, "tzinfo") and start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)

        date_key = start.date().isoformat()
        buckets[date_key].append(_serialize_event_for_tv(event))

    return [
        {"date": date_key, "events": buckets[date_key]}
        for date_key in sorted(buckets.keys())
    ]


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
        tv_state_store.initialize(user_id, selected_date=None, current_view="month")
    state = tv_state_store.get(user_id)

    # Issue a long-lived TV token (8 hours)
    token = create_token(user_id, minutes=480)

    return {
        "token": token,
        "selectedDate": state.get("selectedDate"),
        "currentView": state.get("currentView", "month"),
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
            currentView="month",
            focusedEventId=None,
        )
    return TVStateResponse(
        selectedDate=state.get("selectedDate"),
        currentView=state.get("currentView", "month"),
        focusedEventId=state.get("focusedEventId"),
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
        currentView=updated.get("currentView", "month"),
        focusedEventId=updated.get("focusedEventId"),
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

    Uses selectedDate from TV state as the anchor for a ±31-day window.
    If selectedDate is not set, returns an empty result — never defaults to today().

    Response shape:
        { "selectedDate": "...", "days": [ { "date": "...", "events": [...] } ] }

    Logs: TV_EVENTS_FETCH
    """
    logger.info("TV_EVENTS_FETCH user_id=%s", current_user.id)

    state = tv_state_store.get(current_user.id)
    selected_date_str: Optional[str] = state.get("selectedDate") if state else None

    if not selected_date_str:
        # Do NOT default to today — return empty, let client decide
        return {"selectedDate": None, "days": []}

    try:
        anchor = datetime.fromisoformat(selected_date_str).replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(status_code=400, detail="selectedDate in state is not a valid ISO date")

    window_start = anchor - timedelta(days=31)
    window_end = anchor + timedelta(days=31)

    events = (
        db.query(Event)
        .filter(
            Event.owner_id == current_user.id,
            Event.start_time >= window_start,
            Event.start_time <= window_end,
        )
        .order_by(Event.start_time)
        .all()
    )

    days = _group_events_by_date(events)

    return {
        "selectedDate": selected_date_str,
        "days": days,
    }

from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models import User
from app.services.tv_pairing_service import tv_state_store
from app.routers.tv import _group_events_by_date
from app.models import Event
from datetime import datetime, timedelta, timezone

router = APIRouter(prefix="/display", tags=["display"])


@router.get("/office")
def office(current_user: User = Depends(get_current_user)):
    return {"view": "today tasks + team schedule"}


@router.get("/team/{user_id}")
def team(user_id: int, current_user: User = Depends(get_current_user)):
    return {"view": f"user {user_id} tasks"}


@router.get("/manager")
def manager(current_user: User = Depends(get_current_user)):
    return {"view": "full overview dashboard"}


# ─────────────────────────────────────────────────
# PHASE 7 — TV DISPLAY EXTENSION
# ─────────────────────────────────────────────────

@router.get("/tv")
def display_tv(
    mode: str = "calendar",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    TV display endpoint.

    Returns selectedDate, currentView, and pre-grouped events for the TV screen.
    selectedDate is never substituted with today() — clients handle None explicitly.

    Query params:
        mode: currently only "calendar" is supported
    """
    state = tv_state_store.get(current_user.id)
    selected_date_str: Optional[str] = state.get("selectedDate") if state else None
    current_view: str = state.get("currentView", "month") if state else "month"

    days = []
    if selected_date_str:
        try:
            anchor = datetime.fromisoformat(selected_date_str).replace(tzinfo=timezone.utc)
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
        except ValueError:
            days = []

    return {
        "mode": mode,
        "selectedDate": selected_date_str,
        "currentView": current_view,
        "days": days,
    }

import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, status
from sqlalchemy import delete, update
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models import User, WebSocketTicket

router = APIRouter()
logger = logging.getLogger(__name__)
TICKET_TTL_SECONDS = 60


def _ticket_hash(ticket: str) -> str:
    return hashlib.sha256(ticket.encode("utf-8")).hexdigest()


@router.post("/ws/ticket")
def create_websocket_ticket(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    now = datetime.now(timezone.utc)
    ticket = secrets.token_urlsafe(32)
    expires_at = now + timedelta(seconds=TICKET_TTL_SECONDS)

    db.execute(
        delete(WebSocketTicket).where(
            (WebSocketTicket.expires_at <= now)
            | (WebSocketTicket.consumed_at.is_not(None))
        ).execution_options(synchronize_session=False)
    )
    db.add(
        WebSocketTicket(
            token_hash=_ticket_hash(ticket),
            user_id=current_user.id,
            expires_at=expires_at,
        )
    )
    db.commit()
    return {
        "ticket": ticket,
        "expires_at": expires_at.isoformat(),
        "expires_in_seconds": TICKET_TTL_SECONDS,
    }


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, ticket: str | None = None, db: Session = Depends(get_db)):
    """Accept a live channel only after atomically consuming a one-use ticket."""
    try:
        if not ticket:
            raise ValueError("missing ticket")
        now = datetime.now(timezone.utc)
        user_id = db.execute(
            update(WebSocketTicket)
            .where(
                WebSocketTicket.token_hash == _ticket_hash(ticket),
                WebSocketTicket.consumed_at.is_(None),
                WebSocketTicket.expires_at > now,
            )
            .values(consumed_at=now)
            .returning(WebSocketTicket.user_id)
            .execution_options(synchronize_session=False)
        ).scalar_one_or_none()
        if user_id is None:
            raise ValueError("invalid ticket")
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            raise ValueError("user not found")
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.warning("WebSocket ticket rejected (%s): %s", type(exc).__name__, exc)
        await ws.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await ws.accept()
    try:
        while True:
            data = await ws.receive_text()
            await ws.send_text(f"Update: {data}")
    except WebSocketDisconnect:
        return

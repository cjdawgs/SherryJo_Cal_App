from fastapi import APIRouter, Depends, WebSocket, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User
from app.security import decode_token

router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str, db: Session = Depends(get_db)):
    """
    Authenticated live channel. The JWT is supplied as the `token` query param
    because browsers cannot set headers on WebSocket handshakes.
    """
    try:
        payload = decode_token(token)
        user_id = payload.get("user_id")
        if not user_id:
            raise ValueError("missing user_id")
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            raise ValueError("user not found")
    except Exception:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await ws.accept()
    while True:
        data = await ws.receive_text()
        await ws.send_text(f"Update: {data}")

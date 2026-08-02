import hashlib
from datetime import datetime, timedelta, timezone

import pytest
from starlette.websockets import WebSocketDisconnect

from app.models import WebSocketTicket


def test_ticket_issue_requires_authentication(client):
    assert client.post("/ws/ticket").status_code == 401


def test_ticket_is_hashed_and_accepts_one_connection(client, db, auth_headers):
    response = client.post("/ws/ticket", headers=auth_headers)

    assert response.status_code == 200
    payload = response.json()
    assert payload["expires_in_seconds"] == 60
    ticket = payload["ticket"]

    stored = db.query(WebSocketTicket).one()
    assert stored.token_hash == hashlib.sha256(ticket.encode("utf-8")).hexdigest()
    assert ticket != stored.token_hash

    with client.websocket_connect(f"/ws?ticket={ticket}") as websocket:
        websocket.send_text("ready")
        assert websocket.receive_text() == "Update: ready"

    db.expire_all()
    assert db.query(WebSocketTicket).one().consumed_at is not None

    with pytest.raises(WebSocketDisconnect) as replay:
        with client.websocket_connect(f"/ws?ticket={ticket}"):
            pass
    assert replay.value.code == 1008


def test_expired_ticket_is_rejected(client, db, auth_headers):
    ticket = client.post("/ws/ticket", headers=auth_headers).json()["ticket"]
    stored = db.query(WebSocketTicket).one()
    stored.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db.commit()

    with pytest.raises(WebSocketDisconnect) as rejected:
        with client.websocket_connect(f"/ws?ticket={ticket}"):
            pass
    assert rejected.value.code == 1008


def test_reusable_jwt_query_parameter_is_rejected(client, auth_headers):
    jwt_token = auth_headers["Authorization"].split(" ", 1)[1]

    with pytest.raises(WebSocketDisconnect) as rejected:
        with client.websocket_connect(f"/ws?token={jwt_token}"):
            pass
    assert rejected.value.code == 1008
import uuid

from app.models import Note


def make_event(client, headers, title="Note carrier"):
    response = client.post("/calendar/event", json={
        "title": title,
        "start_time": "2026-05-01T10:00:00Z",
        "end_time": "2026-05-01T11:00:00Z",
    }, headers=headers)
    assert response.status_code == 200
    return response.json()["event"]["id"]


def make_note(db, date, content, event_id=None):
    note = Note(id=str(uuid.uuid4()), date=date, content=content, event_id=event_id)
    db.add(note)
    db.commit()
    return note


# ==================================================
# GET /notes/
# ==================================================

def test_get_notes_filters_by_date(client, db, auth_headers):
    event_id = make_event(client, auth_headers)
    make_note(db, "2026-05-01", "May note", event_id=event_id)
    make_note(db, "2026-05-02", "Other day", event_id=event_id)

    response = client.get("/notes/", params={"date": "2026-05-01"}, headers=auth_headers)

    assert response.status_code == 200
    contents = [note["content"] for note in response.json()]
    assert contents == ["May note"]


def test_get_notes_returns_empty_list_for_unknown_date(client, db, auth_headers):
    response = client.get("/notes/", params={"date": "2030-01-01"}, headers=auth_headers)

    assert response.status_code == 200
    assert response.json() == []


def test_get_notes_requires_date_query_param(client, auth_headers):
    assert client.get("/notes/", headers=auth_headers).status_code == 422


def test_get_notes_requires_authentication(client):
    assert client.get("/notes/", params={"date": "2026-05-01"}).status_code == 401


# ==================================================
# POST /notes/
# ==================================================

def test_create_note_requires_an_owned_event(client, auth_headers):
    assert client.post("/notes/", json={
        "date": "2026-05-03",
        "content": "Buy flowers",
    }, headers=auth_headers).status_code == 400

    assert client.post("/notes/", json={
        "date": "2026-05-03",
        "content": "Buy flowers",
        "event_id": 99999,
    }, headers=auth_headers).status_code == 404


def test_create_note_persists_new_note(client, db, auth_headers):
    event_id = make_event(client, auth_headers)

    response = client.post("/notes/", json={
        "date": "2026-05-03",
        "content": "Buy flowers",
        "event_id": event_id,
    }, headers=auth_headers)

    assert response.status_code == 200
    assert response.json()["content"] == "Buy flowers"
    assert db.query(Note).filter(Note.date == "2026-05-03").count() == 1


def test_create_note_updates_existing_note_for_same_date_and_event(client, db, auth_headers):
    event_id = make_event(client, auth_headers)
    existing = make_note(db, "2026-05-04", "Old content", event_id=event_id)

    response = client.post("/notes/", json={
        "date": "2026-05-04",
        "content": "New content",
        "event_id": event_id,
    }, headers=auth_headers)

    assert response.status_code == 200
    assert response.json()["id"] == existing.id
    assert db.query(Note).filter(Note.date == "2026-05-04").count() == 1
    assert response.json()["content"] == "New content"

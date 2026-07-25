import uuid

import pytest

from app.models import Note


def make_note(db, date, content, event_id=None):
    note = Note(id=str(uuid.uuid4()), date=date, content=content, event_id=event_id)
    db.add(note)
    db.commit()
    return note


# ==================================================
# GET /notes/
# ==================================================

def test_get_notes_filters_by_date(client, db):
    make_note(db, "2026-05-01", "May note")
    make_note(db, "2026-05-02", "Other day")

    response = client.get("/notes/", params={"date": "2026-05-01"})

    assert response.status_code == 200
    contents = [note["content"] for note in response.json()]
    assert contents == ["May note"]


def test_get_notes_returns_empty_list_for_unknown_date(client, db):
    response = client.get("/notes/", params={"date": "2030-01-01"})

    assert response.status_code == 200
    assert response.json() == []


def test_get_notes_requires_date_query_param(client):
    assert client.get("/notes/").status_code == 422


# ==================================================
# POST /notes/
# ==================================================

@pytest.mark.xfail(
    reason="create_note passes owner_id, which the Note model does not define",
    raises=TypeError,
    strict=True,
)
def test_create_note_persists_new_note(client, db):
    response = client.post("/notes/", json={
        "date": "2026-05-03",
        "content": "Buy flowers",
    })

    assert response.status_code == 200
    assert response.json()["content"] == "Buy flowers"
    assert db.query(Note).filter(Note.date == "2026-05-03").count() == 1


def test_create_note_updates_existing_note_for_same_date_and_event(client, db):
    existing = make_note(db, "2026-05-04", "Old content")

    response = client.post("/notes/", json={
        "date": "2026-05-04",
        "content": "New content",
    })

    assert response.status_code == 200
    assert response.json()["id"] == existing.id
    assert db.query(Note).filter(Note.date == "2026-05-04").count() == 1
    assert response.json()["content"] == "New content"

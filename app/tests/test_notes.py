# --------------------------------------------------
# IMPORTS
# --------------------------------------------------

import pytest


# --------------------------------------------------
# ✅ FIX: CREATE EVENT FIXTURE
# --------------------------------------------------

@pytest.fixture
def sample_event(client):
    res = client.post("/events", json={
        "title": "Test Event",
        "description": "Test",
        "start_time": "2026-01-01T10:00:00",
        "end_time": "2026-01-01T11:00:00",
        "owner_id": 1
    })

    assert res.status_code == 200

    return res.json()["id"]


# --------------------------------------------------
# CREATE NOTE
# --------------------------------------------------

def test_create_note(client, sample_event):
    res = client.post("/events/note", json={
        "event_id": sample_event,
        "content": "Test note"
    })

    assert res.status_code == 200
    assert res.json()["ok"] == True


# --------------------------------------------------
# UPDATE NOTE CONTENT
# --------------------------------------------------

def test_update_note_content(client, sample_event):
    # ✅ Create note
    client.post("/events/note", json={
        "event_id": sample_event,
        "content": "Initial content"
    })

    events = client.get("/events").json()

    note_id = events[0]["notes"][0]["id"]

    # ✅ Update note
    res = client.post("/events/note", json={
        "note_id": note_id,
        "content": "Updated content"
    })

    assert res.status_code == 200
    assert res.json()["ok"] == True


# --------------------------------------------------
# SAVE POSITION
# --------------------------------------------------

def test_save_note_position(client, sample_event):
    client.post("/events/note", json={
        "event_id": sample_event,
        "content": "Move me"
    })

    events = client.get("/events").json()
    note = events[0]["notes"][0]

    res = client.post("/events/note", json={
        "note_id": note["id"],
        "x": 300,
        "y": 400
    })

    assert res.status_code == 200


# --------------------------------------------------
# VERIFY POSITION
# --------------------------------------------------

def test_note_position_persisted(client, sample_event):
    client.post("/events/note", json={
        "event_id": sample_event,
        "content": "Position test",
        "x": 250,
        "y": 275
    })

    events = client.get("/events").json()
    note = events[0]["notes"][0]

    assert note["x"] == 250
    assert note["y"] == 275


# --------------------------------------------------
# MULTIPLE NOTES
# --------------------------------------------------

def test_multiple_notes(client, sample_event):
    client.post("/events/note", json={
        "event_id": sample_event,
        "content": "Note 1"
    })

    client.post("/events/note", json={
        "event_id": sample_event,
        "content": "Note 2"
    })

    events = client.get("/events").json()

    assert len(events[0]["notes"]) >= 2

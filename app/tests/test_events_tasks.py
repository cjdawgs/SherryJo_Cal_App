# --------------------------------------------------
# IMPORTS
# --------------------------------------------------

from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


# --------------------------------------------------
# CREATE EVENT ✅
# --------------------------------------------------

def test_create_event(auth_headers):
    response = client.post("/events/", json={
        "title": "Test Meeting",
        "description": "Test Team meeting",
        "start_time": "2026-01-01T10:00:00",
        "end_time": "2026-01-01T11:00:00",
        "owner_id": 1
    }, headers=auth_headers)

    # ✅ FIX: Add assertion
    assert response.status_code == 200

    data = response.json()
    assert data["title"] == "Test Meeting"


# --------------------------------------------------
# GET EVENTS ✅
# --------------------------------------------------

def test_get_events(auth_headers):
    response = client.get("/events/", headers=auth_headers)

    assert response.status_code == 200
    assert isinstance(response.json(), list)


# --------------------------------------------------
# CREATE TASK ✅
# --------------------------------------------------

def test_create_task(auth_headers):
    response = client.post("/tasks/", json={
        "title": "Test Task 1",
        "description": "Test task descriptor",
        "completed": False,
        "owner_id": 1
    }, headers=auth_headers)

    # ✅ FIX: Add assertion
    assert response.status_code == 200

    data = response.json()
    assert data["title"] == "Test Task 1"


# --------------------------------------------------
# GET TASKS ✅
# --------------------------------------------------

def test_get_tasks(auth_headers):
    response = client.get("/tasks/", headers=auth_headers)

    assert response.status_code == 200
    assert isinstance(response.json(), list)
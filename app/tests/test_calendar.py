# ==================================================
# TEST CALENDAR SERVICE (CORE BUSINESS LOGIC)
# ==================================================

"""
These tests focus on CalendarService internal logic.

WHY these matter:
✅ Prevent duplicate events
✅ Ensure time normalization works
✅ Guarantee consistent event IDs
✅ Protect core sync behavior

These are PURE logic tests (no API, no DB, no external calls)
"""

from app.services.calendar_service import CalendarService


# ==================================================
# TEST: NORMALIZE TIME FORMAT
# ==================================================

def test_normalize_time_removes_seconds_and_z():
    """
    Ensure ISO timestamps are normalized properly.
    """

    service = CalendarService()

    input_time = "2024-01-01T10:00:00Z"

    result = service._normalize_time(input_time)

    assert result == "2024-01-01 10:00"


# ==================================================
# TEST: NORMALIZE TIME WITH DATE ONLY
# ==================================================

def test_normalize_time_date_only():
    """
    Ensure date-only values are handled properly.
    """

    service = CalendarService()

    input_time = "2024-01-01"

    result = service._normalize_time(input_time)

    # Should not break — may stay same or be formatted
    assert result.startswith("2024-01-01")


# ==================================================
# TEST: FINGERPRINT CONSISTENCY
# ==================================================

def test_fingerprint_is_consistent():
    """
    Same event should always produce same fingerprint.
    """

    service = CalendarService()

    event = {
        "title": "Meeting",
        "start": "2024-01-01 10:00",
        "end": "2024-01-01 11:00"
    }

    fp1 = service._fingerprint(event)
    fp2 = service._fingerprint(event)

    assert fp1 == fp2


# ==================================================
# TEST: FINGERPRINT DIFFERENT EVENTS
# ==================================================

def test_fingerprint_changes_when_event_changes():
    """
    Different events must produce different fingerprints.
    """

    service = CalendarService()

    e1 = {
        "title": "Meeting",
        "start": "2024-01-01 10:00",
        "end": "2024-01-01 11:00"
    }

    e2 = {
        "title": "Meeting Updated",
        "start": "2024-01-01 10:00",
        "end": "2024-01-01 11:00"
    }

    assert service._fingerprint(e1) != service._fingerprint(e2)


# ==================================================
# TEST: DEDUPLICATE EVENTS
# ==================================================

def test_deduplicate_merges_sources():
    """
    Duplicate events should merge into one with combined sources.
    """

    service = CalendarService()

    events = [
        {
            "title": "Meeting",
            "start": "2024-01-01 10:00",
            "end": "2024-01-01 11:00",
            "source": "google"
        },
        {
            "title": "Meeting",
            "start": "2024-01-01 10:00",
            "end": "2024-01-01 11:00",
            "source": "outlook"
        }
    ]

    result = service._deduplicate(events)

    assert len(result) == 1
    assert "google,outlook" in result[0]["source"]


# ==================================================
# TEST: DEDUPLICATE NO DUPLICATES
# ==================================================

def test_deduplicate_keeps_unique_events():
    """
    Non-duplicate events should remain unchanged.
    """

    service = CalendarService()

    events = [
        {
            "title": "Meeting 1",
            "start": "2024-01-01 10:00",
            "end": "2024-01-01 11:00",
            "source": "google"
        },
        {
            "title": "Meeting 2",
            "start": "2024-01-01 12:00",
            "end": "2024-01-01 13:00",
            "source": "google"
        }
    ]

    result = service._deduplicate(events)

    assert len(result) == 2


# ==================================================
# TEST: NORMALIZATION OF GOOGLE EVENTS
# ==================================================

def test_normalize_google_event_structure():
    """
    Ensure Google event is mapped into unified format.
    """

    service = CalendarService()

    google_event = {
        "id": "123",
        "summary": "Test Event",
        "start": {"dateTime": "2024-01-01T10:00:00Z"},
        "end": {"dateTime": "2024-01-01T11:00:00Z"},
    }

    result = service._normalize([google_event], [])

    assert result[0]["title"] == "Test Event"
    assert result[0]["source"] == "google"
    assert "start" in result[0]
    assert "end" in result[0]


# ==================================================
# TEST: NORMALIZATION OF OUTLOOK EVENTS
# ==================================================

def test_normalize_outlook_event_structure():
    """
    Ensure Outlook event is mapped into unified format.
    """

    service = CalendarService()

    outlook_event = {
        "id": "abc",
        "subject": "Outlook Event",
        "start": {"dateTime": "2024-01-01T10:00:00"},
        "end": {"dateTime": "2024-01-01T11:00:00"},
    }

    result = service._normalize([], [outlook_event])

    assert result[0]["title"] == "Outlook Event"
    assert result[0]["source"] == "outlook"
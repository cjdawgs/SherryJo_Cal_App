from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.services import external_calendar_service as ecs
from app.services.external_calendar_service import (
    ExternalCalendarService,
    import_into_internal,
    merge_external_events,
)


@pytest.fixture
def service():
    return ExternalCalendarService()


def make_vevent(uid="uid-1", summary="Lunch", description="With Sherry", start=None, end=None):
    fields = {
        "uid": SimpleNamespace(value=uid),
        "summary": SimpleNamespace(value=summary),
        "description": SimpleNamespace(value=description),
    }
    if start is not None:
        fields["dtstart"] = SimpleNamespace(value=start)
    if end is not None:
        fields["dtend"] = SimpleNamespace(value=end)
    return SimpleNamespace(**fields)


def make_caldav(calendars=None, principal_error=None):
    """Build a fake caldav module whose DAVClient returns the given calendars."""
    principal = MagicMock()
    principal.calendars.return_value = calendars if calendars is not None else []

    client = MagicMock()
    if principal_error is not None:
        client.principal.side_effect = principal_error
    else:
        client.principal.return_value = principal

    return SimpleNamespace(DAVClient=MagicMock(return_value=client))


# ==================================================
# DATE PARSING
# ==================================================

def test_parse_date_returns_none_for_empty(service):
    assert service._parse_date(None) is None


def test_parse_date_accepts_naive_datetime(service):
    parsed = service._parse_date(datetime(2026, 3, 1, 9, 30))

    assert parsed == datetime(2026, 3, 1, 9, 30, tzinfo=timezone.utc)


def test_parse_date_converts_aware_datetime_to_utc(service):
    aware = datetime.fromisoformat("2026-03-01T09:30:00+02:00")

    assert service._parse_date(aware) == datetime(2026, 3, 1, 7, 30, tzinfo=timezone.utc)


def test_parse_date_expands_plain_date_to_midnight_utc(service):
    assert service._parse_date(date(2026, 3, 1)) == datetime(2026, 3, 1, tzinfo=timezone.utc)


def test_parse_date_parses_iso_string_with_z(service):
    assert service._parse_date("2026-03-01T09:30:00Z") == datetime(
        2026, 3, 1, 9, 30, tzinfo=timezone.utc
    )


def test_parse_date_reads_vobject_datetime_value(service):
    wrapper = SimpleNamespace(value=datetime(2026, 3, 1, 9, 30))

    assert service._parse_date(wrapper) == datetime(2026, 3, 1, 9, 30, tzinfo=timezone.utc)


def test_parse_date_reads_vobject_all_day_value(service):
    wrapper = SimpleNamespace(value=date(2026, 3, 1))

    assert service._parse_date(wrapper) == datetime(2026, 3, 1, tzinfo=timezone.utc)


def test_parse_date_reads_vobject_string_value(service):
    wrapper = SimpleNamespace(value="2026-03-01T09:30:00+00:00")

    assert service._parse_date(wrapper) == datetime(2026, 3, 1, 9, 30, tzinfo=timezone.utc)


def test_parse_date_returns_none_for_unknown_value_type(service):
    assert service._parse_date(SimpleNamespace(value=object())) is None


def test_parse_date_returns_none_on_parse_error(service):
    assert service._parse_date("not-a-date") is None


# ==================================================
# NORMALIZATION
# ==================================================

def test_normalize_event_maps_provider_fields(service):
    start = datetime(2026, 3, 1, 9, tzinfo=timezone.utc)

    normalized = service._normalize_event({
        "id": "abc",
        "title": "Dentist",
        "description": "Cleaning",
        "start": start,
        "end": None,
        "source": "apple",
    })

    assert normalized == {
        "id": "abc",
        "summary": "Dentist",
        "subject": "Dentist",
        "description": "Cleaning",
        "start": start,
        "end": None,
        "source": "apple",
    }


def test_normalize_event_defaults_missing_fields(service):
    normalized = service._normalize_event({})

    assert normalized["summary"] == ""
    assert normalized["source"] == "external"
    assert normalized["id"].startswith("apple-")


# ==================================================
# VEVENT EXTRACTION
# ==================================================

def test_extract_vevent_from_vobject_instance(service):
    vevent = make_vevent()
    event = SimpleNamespace(vobject_instance=SimpleNamespace(vevent=vevent))

    assert service._extract_vevent(event) is vevent


def test_extract_vevent_calls_callable_vobject_instance(service):
    vevent = make_vevent()
    event = SimpleNamespace(vobject_instance=lambda: SimpleNamespace(vevent=vevent))

    assert service._extract_vevent(event) is vevent


def test_extract_vevent_falls_back_to_raw_ics(service, monkeypatch):
    vevent = make_vevent()
    monkeypatch.setattr(
        ecs, "vobject", SimpleNamespace(readOne=lambda _raw: SimpleNamespace(vevent=vevent))
    )
    event = SimpleNamespace(vobject_instance=None, data="BEGIN:VCALENDAR")

    assert service._extract_vevent(event) is vevent


def test_extract_vevent_returns_none_when_ics_unparseable(service, monkeypatch):
    def boom(_raw):
        raise ValueError("bad ics")

    monkeypatch.setattr(ecs, "vobject", SimpleNamespace(readOne=boom))
    event = SimpleNamespace(vobject_instance=None, data="garbage")

    assert service._extract_vevent(event) is None


def test_extract_vevent_returns_none_when_callable_raises(service):
    def boom():
        raise RuntimeError("no vobject")

    assert service._extract_vevent(SimpleNamespace(vobject_instance=boom, data=None)) is None


# ==================================================
# CREDENTIAL VALIDATION
# ==================================================

def test_validate_requires_caldav_dependency(service, monkeypatch):
    monkeypatch.setattr(ecs, "caldav", None)

    ok, message = service.validate_icloud_credentials_detailed("url", "user", "pass")

    assert ok is False
    assert "caldav dependency" in message


def test_validate_requires_all_fields(service, monkeypatch):
    monkeypatch.setattr(ecs, "caldav", make_caldav())

    ok, message = service.validate_icloud_credentials_detailed("", "user", "pass")

    assert ok is False
    assert "required" in message


def test_validate_succeeds_with_calendars(service, monkeypatch):
    monkeypatch.setattr(ecs, "caldav", make_caldav(calendars=[MagicMock()]))

    ok, message = service.validate_icloud_credentials_detailed("url", "user", "pass")

    assert ok is True
    assert "successful" in message


def test_validate_fails_without_calendars(service, monkeypatch):
    monkeypatch.setattr(ecs, "caldav", make_caldav(calendars=[]))

    ok, message = service.validate_icloud_credentials_detailed("url", "user", "pass")

    assert ok is False
    assert "no iCloud calendars found" in message


def test_validate_fails_without_principal(service, monkeypatch):
    caldav_module = make_caldav()
    caldav_module.DAVClient.return_value.principal.return_value = None
    monkeypatch.setattr(ecs, "caldav", caldav_module)

    ok, message = service.validate_icloud_credentials_detailed("url", "user", "pass")

    assert ok is False
    assert "principal" in message


@pytest.mark.parametrize("error,expected", [
    ("401 Unauthorized", "Apple rejected credentials"),
    ("403 Forbidden", "forbidden"),
    ("SSL handshake failure", "SSL/TLS error"),
    ("connection timed out", "timed out"),
    ("something odd", "Apple CalDAV error"),
])
def test_validate_maps_provider_errors(service, monkeypatch, error, expected):
    monkeypatch.setattr(ecs, "caldav", make_caldav(principal_error=Exception(error)))

    ok, message = service.validate_icloud_credentials_detailed("url", "user", "pass")

    assert ok is False
    assert expected in message


def test_validate_icloud_credentials_returns_bool(service, monkeypatch):
    monkeypatch.setattr(ecs, "caldav", make_caldav(calendars=[MagicMock()]))

    assert service.validate_icloud_credentials("url", "user", "pass") is True


def test_validate_icloud_credentials_never_raises(service, monkeypatch):
    monkeypatch.setattr(ecs, "caldav", make_caldav(principal_error=Exception("boom")))

    assert service.validate_icloud_credentials("url", "user", "pass") is False


# ==================================================
# EVENT FETCHING
# ==================================================

def test_fetch_icloud_events_requires_caldav(service, monkeypatch):
    monkeypatch.setattr(ecs, "caldav", None)

    with pytest.raises(ImportError):
        service.fetch_icloud_events("url", "user", "pass")


def test_fetch_icloud_events_normalizes_results(service, monkeypatch):
    vevent = make_vevent(start=datetime(2026, 3, 1, 9, tzinfo=timezone.utc),
                         end=datetime(2026, 3, 1, 10, tzinfo=timezone.utc))
    calendar = MagicMock()
    calendar.date_search.return_value = [SimpleNamespace(
        vobject_instance=SimpleNamespace(vevent=vevent)
    )]
    monkeypatch.setattr(ecs, "caldav", make_caldav(calendars=[calendar]))

    events = service.fetch_icloud_events("url", "user", "pass")

    assert len(events) == 1
    assert events[0]["summary"] == "Lunch"
    assert events[0]["source"] == "apple"
    assert events[0]["start"] == datetime(2026, 3, 1, 9, tzinfo=timezone.utc)


def test_fetch_icloud_events_falls_back_to_events_call(service, monkeypatch):
    vevent = make_vevent(start=datetime(2026, 3, 1, 9, tzinfo=timezone.utc))
    calendar = MagicMock()
    calendar.date_search.side_effect = Exception("date_search unsupported")
    calendar.events.return_value = [SimpleNamespace(
        vobject_instance=SimpleNamespace(vevent=vevent)
    )]
    monkeypatch.setattr(ecs, "caldav", make_caldav(calendars=[calendar]))

    events = service.fetch_icloud_events("url", "user", "pass")

    calendar.events.assert_called_once()
    assert len(events) == 1


def test_fetch_icloud_events_uses_end_when_start_missing(service, monkeypatch):
    vevent = make_vevent(start=None, end=datetime(2026, 3, 1, 10, tzinfo=timezone.utc))
    calendar = MagicMock()
    calendar.date_search.return_value = [SimpleNamespace(
        vobject_instance=SimpleNamespace(vevent=vevent)
    )]
    monkeypatch.setattr(ecs, "caldav", make_caldav(calendars=[calendar]))

    events = service.fetch_icloud_events("url", "user", "pass")

    assert events[0]["start"] == datetime(2026, 3, 1, 10, tzinfo=timezone.utc)


def test_fetch_icloud_events_skips_undated_and_unparsable_entries(service, monkeypatch):
    undated = SimpleNamespace(vobject_instance=SimpleNamespace(vevent=make_vevent()))
    no_vevent = SimpleNamespace(vobject_instance=None, data=None)
    calendar = MagicMock()
    calendar.date_search.return_value = [undated, no_vevent]
    monkeypatch.setattr(ecs, "caldav", make_caldav(calendars=[calendar]))

    assert service.fetch_icloud_events("url", "user", "pass") == []


def test_fetch_icloud_events_returns_empty_on_connection_failure(service, monkeypatch):
    monkeypatch.setattr(ecs, "caldav", make_caldav(principal_error=Exception("offline")))

    assert service.fetch_icloud_events("url", "user", "pass") == []


def test_fetch_apple_calendar_events_reads_account_credentials(service, monkeypatch):
    vevent = make_vevent(start=datetime(2026, 3, 1, 9, tzinfo=timezone.utc))
    calendar = MagicMock()
    calendar.date_search.return_value = [SimpleNamespace(
        vobject_instance=SimpleNamespace(vevent=vevent)
    )]
    caldav_module = make_caldav(calendars=[calendar])
    monkeypatch.setattr(ecs, "caldav", caldav_module)

    account = SimpleNamespace(
        access_token="https://caldav.icloud.com",
        account_email="user@icloud.com",
        refresh_token="app-password",
    )

    events = ExternalCalendarService.fetch_apple_calendar_events(account)

    assert len(events) == 1
    caldav_module.DAVClient.assert_called_once_with(
        url="https://caldav.icloud.com",
        username="user@icloud.com",
        password="app-password",
    )


def test_fetch_apple_calendar_events_without_credentials():
    account = SimpleNamespace(access_token=None, account_email=None, refresh_token=None)

    assert ExternalCalendarService.fetch_apple_calendar_events(account) == []


def test_fetch_apple_calendar_events_swallows_errors():
    assert ExternalCalendarService.fetch_apple_calendar_events(object()) == []


def test_fetch_google_events_is_placeholder(service):
    assert service.fetch_google_events("token") == []


# ==================================================
# HELPERS
# ==================================================

def test_merge_external_events_ignores_empty_lists():
    assert merge_external_events([{"id": 1}], None, [], [{"id": 2}]) == [{"id": 1}, {"id": 2}]


def test_merge_external_events_without_arguments():
    assert merge_external_events() == []


def test_import_into_internal_logs_without_writing(caplog):
    with caplog.at_level("INFO", logger=ecs.logger.name):
        import_into_internal([{"id": 1}, {"id": 2}])

    assert "2 events ready for import" in caplog.text

from datetime import datetime, timezone
from types import SimpleNamespace

from app.utils.recurrence import expand_event_occurrences


def _serialize(event):
    return {
        "id": event.id,
        "title": event.title,
        "start": event.start_time.isoformat(),
        "end": event.end_time.isoformat() if event.end_time else None,
        "extendedProps": {"backendId": event.id},
    }


def _event(recurrence):
    return SimpleNamespace(
        id=7,
        title="Recurring",
        start_time=datetime(2026, 8, 3, 13, 0, tzinfo=timezone.utc),
        end_time=datetime(2026, 8, 3, 14, 0, tzinfo=timezone.utc),
        recurrence=recurrence,
    )


def test_weekly_recurrence_uses_selected_weekdays_and_until_date():
    event = _event({
        "enabled": True,
        "frequency": "weekly",
        "interval": 1,
        "weekdays": [0, 2],
        "until": "2026-08-12",
    })

    occurrences = expand_event_occurrences(
        event,
        datetime(2026, 8, 1, tzinfo=timezone.utc),
        datetime(2026, 8, 20, 23, 59, tzinfo=timezone.utc),
        _serialize,
    )

    assert [item["start"][:10] for item in occurrences] == ["2026-08-03", "2026-08-05", "2026-08-10", "2026-08-12"]
    assert all(item["extendedProps"]["backendId"] == 7 for item in occurrences)


def test_daily_recurrence_supports_intraday_interval_window():
    event = _event({
        "enabled": True,
        "frequency": "daily",
        "repeat_minutes": 120,
        "daily_start": "08:00",
        "daily_end": "12:00",
        "until": "2026-08-03",
    })

    occurrences = expand_event_occurrences(
        event,
        datetime(2026, 8, 3, tzinfo=timezone.utc),
        datetime(2026, 8, 3, 23, 59, tzinfo=timezone.utc),
        _serialize,
    )

    assert [item["start"][11:16] for item in occurrences] == ["08:00", "10:00", "12:00"]
    assert [item["end"][11:16] for item in occurrences] == ["09:00", "11:00", "13:00"]


def test_monthly_recurrence_keeps_start_day_and_multi_day_duration():
    event = _event({"enabled": True, "frequency": "monthly", "interval": 1})
    event.end_time = datetime(2026, 8, 5, 14, 0, tzinfo=timezone.utc)

    occurrences = expand_event_occurrences(
        event,
        datetime(2026, 9, 1, tzinfo=timezone.utc),
        datetime(2026, 10, 31, 23, 59, tzinfo=timezone.utc),
        _serialize,
    )

    assert [item["start"][:10] for item in occurrences] == ["2026-09-03", "2026-10-03"]
    assert [item["end"][:10] for item in occurrences] == ["2026-09-05", "2026-10-05"]
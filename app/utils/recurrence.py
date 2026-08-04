"""Bounded expansion for locally-authored recurring events."""

from __future__ import annotations

from datetime import datetime, time, timedelta
from typing import Callable

from dateutil.rrule import DAILY, MONTHLY, WEEKLY, MO, TU, WE, TH, FR, SA, SU, rrule


_FREQUENCIES = {"daily": DAILY, "weekly": WEEKLY, "monthly": MONTHLY}
_WEEKDAYS = (MO, TU, WE, TH, FR, SA, SU)


def normalize_recurrence(value) -> dict | None:
    if not isinstance(value, dict) or value.get("enabled") is not True:
        return None
    frequency = str(value.get("frequency") or "weekly").lower()
    if frequency not in _FREQUENCIES:
        return None
    interval = max(1, min(int(value.get("interval") or 1), 999))
    weekdays = sorted({int(day) for day in value.get("weekdays", []) if str(day).isdigit() and 0 <= int(day) <= 6})
    repeat_minutes = max(0, min(int(value.get("repeat_minutes") or 0), 1440))
    return {
        "enabled": True,
        "frequency": frequency,
        "interval": interval,
        "weekdays": weekdays,
        "repeat_minutes": repeat_minutes,
        "daily_start": str(value.get("daily_start") or ""),
        "daily_end": str(value.get("daily_end") or ""),
        "until": str(value.get("until") or ""),
    }


def _parse_clock(value: str, fallback: time) -> time:
    try:
        return time.fromisoformat(value)
    except (TypeError, ValueError):
        return fallback


def expand_event_occurrences(event, window_start: datetime, window_end: datetime, serializer: Callable) -> list[dict]:
    recurrence = normalize_recurrence(getattr(event, "recurrence", None))
    if not recurrence:
        return [serializer(event)]

    start = event.start_time
    if start.tzinfo is None and window_start.tzinfo is not None:
        start = start.replace(tzinfo=window_start.tzinfo)
    elif start.tzinfo is not None and window_start.tzinfo is None:
        window_start = window_start.replace(tzinfo=start.tzinfo)
        window_end = window_end.replace(tzinfo=start.tzinfo)
    end = event.end_time or start
    if end.tzinfo is None and start.tzinfo is not None:
        end = end.replace(tzinfo=start.tzinfo)
    duration = max(end - start, timedelta(0))
    until = window_end
    if recurrence["until"]:
        try:
            until_date = datetime.fromisoformat(recurrence["until"]).date()
            until = min(until, datetime.combine(until_date, time.max, tzinfo=start.tzinfo))
        except ValueError:
            pass

    kwargs = {
        "freq": _FREQUENCIES[recurrence["frequency"]],
        "dtstart": start,
        "interval": recurrence["interval"],
        "until": until,
    }
    if recurrence["frequency"] == "weekly" and recurrence["weekdays"]:
        kwargs["byweekday"] = [_WEEKDAYS[index] for index in recurrence["weekdays"]]

    occurrences = []
    search_start = max(window_start - duration, start)
    for base_start in rrule(**kwargs).between(search_start, window_end, inc=True):
        daily_start = _parse_clock(recurrence["daily_start"], base_start.timetz().replace(tzinfo=None))
        daily_end = _parse_clock(recurrence["daily_end"], daily_start)
        occurrence_start = base_start.replace(hour=daily_start.hour, minute=daily_start.minute, second=0, microsecond=0)
        starts = [occurrence_start]
        if recurrence["repeat_minutes"] > 0:
            daily_limit = occurrence_start.replace(hour=daily_end.hour, minute=daily_end.minute)
            cursor = occurrence_start + timedelta(minutes=recurrence["repeat_minutes"])
            while cursor <= daily_limit:
                starts.append(cursor)
                cursor += timedelta(minutes=recurrence["repeat_minutes"])

        for instance_start in starts:
            instance_end = instance_start + duration
            if instance_end < window_start or instance_start > window_end:
                continue
            item = serializer(event)
            item["id"] = f"{event.id}:rec:{instance_start.isoformat()}"
            item["start"] = instance_start.isoformat()
            item["end"] = instance_end.isoformat() if event.end_time else None
            item["recurrence"] = recurrence
            item["recurrence_parent_id"] = event.id
            item.setdefault("extendedProps", {})["backendId"] = event.id
            item["extendedProps"]["recurrence"] = recurrence
            item["extendedProps"]["recurrenceParentId"] = event.id
            occurrences.append(item)
    return occurrences
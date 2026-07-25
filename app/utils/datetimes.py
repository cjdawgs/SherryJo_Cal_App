"""Datetime normalization helpers shared by routers and services."""

from datetime import date, datetime, timezone
from typing import Any, Optional


def parse_iso_datetime(value: Any) -> Optional[datetime]:
    """Parse an ISO-8601 string (``Z`` suffix allowed) into an aware UTC datetime."""
    if not value:
        return None

    if not isinstance(value, str):
        return None

    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None

    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)

    return parsed.astimezone(timezone.utc)


def ensure_utc(value: Any) -> Optional[datetime]:
    """Coerce datetimes, dates and ISO strings into aware UTC datetimes."""
    if value is None or value == "":
        return None

    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)

    if isinstance(value, str):
        return parse_iso_datetime(value)

    return None


def iso_or_none(value: Any) -> Optional[str]:
    """Return ``value.isoformat()`` when the value is set, otherwise ``None``."""
    if not value:
        return None
    if isinstance(value, str):
        return value
    return value.isoformat()

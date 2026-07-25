from datetime import date, datetime, timezone

import pytest
from fastapi import HTTPException

from app.utils import (
    ensure_utc,
    iso_or_none,
    normalize_hex_color,
    parse_iso_datetime,
    sanitize_hex_color,
)


def test_parse_iso_datetime_handles_z_suffix_and_naive_values():
    assert parse_iso_datetime("2024-01-02T03:04:05Z") == datetime(
        2024, 1, 2, 3, 4, 5, tzinfo=timezone.utc
    )
    assert parse_iso_datetime("2024-01-02T03:04:05") == datetime(
        2024, 1, 2, 3, 4, 5, tzinfo=timezone.utc
    )
    assert parse_iso_datetime("2024-01-02T03:04:05+02:00") == datetime(
        2024, 1, 2, 1, 4, 5, tzinfo=timezone.utc
    )


def test_parse_iso_datetime_returns_none_for_invalid_input():
    assert parse_iso_datetime("") is None
    assert parse_iso_datetime(None) is None
    assert parse_iso_datetime("not-a-date") is None
    assert parse_iso_datetime(datetime(2024, 1, 1)) is None


def test_ensure_utc_accepts_datetime_date_and_string():
    assert ensure_utc(datetime(2024, 1, 1, 12)) == datetime(
        2024, 1, 1, 12, tzinfo=timezone.utc
    )
    assert ensure_utc(date(2024, 1, 1)) == datetime(2024, 1, 1, tzinfo=timezone.utc)
    assert ensure_utc("2024-01-01T00:00:00Z") == datetime(
        2024, 1, 1, tzinfo=timezone.utc
    )
    assert ensure_utc(None) is None
    assert ensure_utc(object()) is None


def test_iso_or_none():
    assert iso_or_none(None) is None
    assert iso_or_none(datetime(2024, 1, 1, tzinfo=timezone.utc)) == (
        "2024-01-01T00:00:00+00:00"
    )
    assert iso_or_none("2024-01-01") == "2024-01-01"


def test_normalize_hex_color_falls_back_for_invalid_values():
    assert normalize_hex_color("#AABBCC") == "#AABBCC"
    assert normalize_hex_color("nope") == "#4F8EF7"
    assert normalize_hex_color(None, fallback="#000000") == "#000000"


def test_sanitize_hex_color_rejects_invalid_values():
    assert sanitize_hex_color("#AABBCC") == "#aabbcc"
    with pytest.raises(HTTPException) as exc_info:
        sanitize_hex_color("red")
    assert exc_info.value.status_code == 422

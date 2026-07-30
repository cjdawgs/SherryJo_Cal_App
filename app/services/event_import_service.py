from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from dateutil import parser as date_parser
from icalendar import Calendar

from app.utils import ensure_utc


class EventImportError(Exception):
    pass


@dataclass
class ParsedImportEvent:
    title: str
    start_time: datetime
    end_time: datetime | None
    description: str
    sticky_notes: list[dict[str, Any]]


def parse_import_payload(filename: str, payload: bytes) -> tuple[list[ParsedImportEvent], list[str]]:
    ext = _extension(filename)
    if ext in {"ics", "ical"}:
        return _parse_ics(payload)
    if ext == "csv":
        return _parse_csv(payload)
    if ext == "json":
        return _parse_json(payload)
    raise EventImportError("Unsupported file type. Use .ics, .ical, .csv, or .json")


def append_sticky_notes_to_description(description: str, sticky_notes: list[dict[str, Any]]) -> str:
    if not sticky_notes:
        return description or ""

    note_lines = [
        str(note.get("content") or "").strip()
        for note in sticky_notes
        if isinstance(note, dict)
    ]
    note_lines = [line for line in note_lines if line]
    if not note_lines:
        return description or ""

    sticky_block = "Sticky Notes:\n" + "\n".join(f"- {line}" for line in note_lines)
    base = (description or "").strip()
    if not base:
        return sticky_block
    return f"{base}\n\n{sticky_block}"


def _extension(filename: str) -> str:
    parts = (filename or "").lower().rsplit(".", 1)
    return parts[1] if len(parts) == 2 else ""


def _parse_ics(payload: bytes) -> tuple[list[ParsedImportEvent], list[str]]:
    warnings: list[str] = []
    events: list[ParsedImportEvent] = []

    try:
        cal = Calendar.from_ical(payload)
    except Exception as exc:
        raise EventImportError(f"Invalid ICS file: {exc}") from exc

    for component in cal.walk(name="VEVENT"):
        try:
            title = str(component.get("SUMMARY") or "Untitled Event").strip() or "Untitled Event"
            description = str(component.get("DESCRIPTION") or "").strip()

            dt_start = _coerce_ical_dt(component.get("DTSTART"))
            dt_end = _coerce_ical_dt(component.get("DTEND"))

            if dt_start is None:
                warnings.append(f"Skipped '{title}': missing DTSTART")
                continue

            start_utc = ensure_utc(dt_start)
            end_utc = ensure_utc(dt_end) if dt_end else None

            if end_utc and end_utc <= start_utc:
                end_utc = start_utc + timedelta(hours=1)

            events.append(
                ParsedImportEvent(
                    title=title,
                    start_time=start_utc,
                    end_time=end_utc,
                    description=description,
                    sticky_notes=[],
                )
            )
        except Exception as exc:
            warnings.append(f"Skipped ICS event due to parse error: {exc}")

    return events, warnings


def _coerce_ical_dt(field: Any) -> datetime | None:
    if field is None:
        return None
    raw = getattr(field, "dt", None)
    if raw is None:
        return None

    if isinstance(raw, datetime):
        return raw

    if isinstance(raw, date):
        return datetime.combine(raw, time.min, tzinfo=timezone.utc)

    try:
        parsed = date_parser.parse(str(raw))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed
    except Exception:
        return None


def _parse_csv(payload: bytes) -> tuple[list[ParsedImportEvent], list[str]]:
    warnings: list[str] = []
    events: list[ParsedImportEvent] = []

    try:
        text = payload.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = payload.decode("latin-1")

    reader = csv.DictReader(io.StringIO(text))

    for idx, row in enumerate(reader, start=2):
        title = _field(row, ["title", "summary", "name", "subject"]) or "Untitled Event"
        description = _field(row, ["description", "notes", "body"]) or ""

        start_raw = _field(row, ["start", "start_time", "start_date", "dtstart"])
        end_raw = _field(row, ["end", "end_time", "end_date", "dtend"])

        if not start_raw:
            warnings.append(f"Row {idx}: missing start date/time")
            continue

        start_dt = _coerce_generic_datetime(start_raw)
        end_dt = _coerce_generic_datetime(end_raw) if end_raw else None

        if start_dt is None:
            warnings.append(f"Row {idx}: invalid start date/time '{start_raw}'")
            continue

        if end_dt and end_dt <= start_dt:
            end_dt = start_dt + timedelta(hours=1)

        events.append(
            ParsedImportEvent(
                title=title,
                start_time=start_dt,
                end_time=end_dt,
                description=description,
                sticky_notes=[],
            )
        )

    return events, warnings


def _parse_json(payload: bytes) -> tuple[list[ParsedImportEvent], list[str]]:
    warnings: list[str] = []
    events: list[ParsedImportEvent] = []

    try:
        data = json.loads(payload.decode("utf-8"))
    except Exception as exc:
        raise EventImportError(f"Invalid JSON file: {exc}") from exc

    if isinstance(data, dict):
        rows = data.get("events")
        if not isinstance(rows, list):
            rows = [data]
    elif isinstance(data, list):
        rows = data
    else:
        raise EventImportError("JSON must be an object, an array, or an object with an 'events' array")

    for idx, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            warnings.append(f"Entry {idx}: skipped non-object item")
            continue

        title = _field(row, ["title", "summary", "name", "subject"]) or "Untitled Event"
        description = _field(row, ["description", "notes", "body"]) or ""
        start_raw = _field(row, ["start", "start_time", "startDate", "start_date", "dtstart"])
        end_raw = _field(row, ["end", "end_time", "endDate", "end_date", "dtend"])

        if not start_raw:
            warnings.append(f"Entry {idx}: missing start date/time")
            continue

        start_dt = _coerce_generic_datetime(start_raw)
        end_dt = _coerce_generic_datetime(end_raw) if end_raw else None
        if start_dt is None:
            warnings.append(f"Entry {idx}: invalid start date/time '{start_raw}'")
            continue

        if end_dt and end_dt <= start_dt:
            end_dt = start_dt + timedelta(hours=1)

        sticky_notes = _normalize_sticky_notes(row.get("sticky_notes") or row.get("stickyNotes"))

        events.append(
            ParsedImportEvent(
                title=title,
                start_time=start_dt,
                end_time=end_dt,
                description=description,
                sticky_notes=sticky_notes,
            )
        )

    return events, warnings


def _normalize_sticky_notes(raw: Any) -> list[dict[str, Any]]:
    if raw is None:
        return []

    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return []
        return [{"content": text, "color": "#F7E68A"}]

    if not isinstance(raw, list):
        return []

    out: list[dict[str, Any]] = []
    for item in raw:
        if isinstance(item, str):
            text = item.strip()
            if text:
                out.append({"content": text, "color": "#F7E68A"})
            continue
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or item.get("text") or "").strip()
        if not content:
            continue
        out.append({
            "content": content,
            "color": str(item.get("color") or "#F7E68A"),
            "createdAt": item.get("createdAt"),
            "updatedAt": item.get("updatedAt"),
        })
    return out


def _field(row: dict[str, Any], keys: list[str]) -> str | None:
    for key in keys:
        if key not in row:
            continue
        value = row.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return None


def _coerce_generic_datetime(raw: Any) -> datetime | None:
    if raw is None:
        return None
    if isinstance(raw, datetime):
        return ensure_utc(raw)
    if isinstance(raw, date):
        return datetime.combine(raw, time.min, tzinfo=timezone.utc)

    text = str(raw).strip()
    if not text:
        return None

    try:
        parsed = date_parser.parse(text)
    except Exception:
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return ensure_utc(parsed)
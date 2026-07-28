
# ==================================================
# ✅ IMPORTS
# ==================================================

import logging
import requests
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)


# ==================================================
# ✅ CONSTANTS
# ==================================================

GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0"


def _parse_iso_utc(value):
    if not value:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(text)
        except Exception:
            return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _extract_event_id_from_location(location_value: str | None) -> str | None:
    if not location_value:
        return None
    raw = str(location_value).strip().rstrip("/")
    if not raw:
        return None
    if "/events/" not in raw:
        return None
    candidate = raw.split("/events/", 1)[-1].split("?", 1)[0].strip()
    return candidate or None


def _graph_error_detail(response, fallback_prefix: str) -> str:
    status_code = getattr(response, "status_code", "unknown")
    try:
        payload = response.json() or {}
    except Exception:
        payload = {}

    error = payload.get("error") if isinstance(payload, dict) else None
    code = str(error.get("code") or "").strip() if isinstance(error, dict) else ""
    message = str(error.get("message") or "").strip() if isinstance(error, dict) else ""
    text = str(getattr(response, "text", "") or "").strip()

    if code and message:
        return f"{fallback_prefix} ({status_code} {code}): {message}"
    if message:
        return f"{fallback_prefix} ({status_code}): {message}"
    if text:
        return f"{fallback_prefix} ({status_code}): {text}"
    return f"{fallback_prefix} ({status_code})"


# ==================================================
# ✅ GRAPH CLIENT (FINAL VERSION)
# ==================================================

class GraphClient:
    """
    ✅ PURPOSE:
    Simple Microsoft Graph API client

    ✅ DESIGN RULE:
    - DOES NOT manage tokens
    - Receives already-valid access_token
    - Token lifecycle handled by: ensure_valid_token()

    ✅ THIS FIXES:
    - re-auth loops
    - conflicting token systems
    - broken refresh flow
    """

    # ==================================================
    # ✅ FETCH EVENTS
    # ==================================================
    def get_events_with_token(self, access_token, start=None, end=None):
        """
        ✅ PURPOSE:
        Fetch Outlook events WITH recurring expansion (calendarView)

        ✅ FIX:
        Uses /calendarView instead of /events
        """

        if not start or not end:
            # fallback window (safe default)
            from datetime import datetime, timezone, timedelta
            now = datetime.now(timezone.utc)
            start = now - timedelta(days=180)
            end = now + timedelta(days=365)

        url = f"{GRAPH_BASE_URL}/me/calendarView"

        headers = {
            "Authorization": f"Bearer {access_token}"
        }

        params = {
            "startDateTime": start.isoformat(),
            "endDateTime": end.isoformat()
        }

        events = []

        while url:
            response = requests.get(url, headers=headers, params=params)

            if response.status_code != 200:
                logger.error("❌ Microsoft calendarView failed: %s", response.text)
                break

            data = response.json()

            batch = data.get("value", [])
            events.extend(batch)

            # ✅ pagination support
            url = data.get("@odata.nextLink")

            # ✅ only include params first call
            params = None

        return {"value": events}

    def get_events(self, db=None, user=None, start=None, end=None):
        """
        Backward-compatible wrapper used by legacy tests/callers.
        """
        token = getattr(user, "ms_access_token", None) if user is not None else None
        if not token:
            return {"value": []}
        return self.get_events_with_token(token, start=start, end=end)

    def get_tasks(self, db=None, user=None):
        """
        Backward-compatible task fetch for Microsoft To Do tests.
        """
        token = getattr(user, "ms_access_token", None) if user is not None else None
        if not token:
            return {"value": []}

        url = f"{GRAPH_BASE_URL}/me/todo/tasks"
        response = requests.get(url, headers={"Authorization": f"Bearer {token}"})
        if response.status_code != 200:
            return {"value": []}
        data = response.json() or {}
        if "value" not in data:
            data["value"] = []
        return data

    # ==================================================
    # ✅ UPDATE EVENT
    # ==================================================

    def update_event(self, token, event_id, updates, raise_on_error: bool = False):
        """
        ✅ PURPOSE:
        Update event in Outlook

        ✅ INPUTS:
        - token → valid access token
        - event_id → Microsoft event ID
        - updates → dict of changes
        """

        url = f"{GRAPH_BASE_URL}/me/events/{event_id}"

        payload = {}

        # ✅ Outlook uses "subject"
        if "title" in updates:
            payload["subject"] = updates["title"]

        # ✅ Start time (must include timezone)
        if "start_time" in updates:
            payload["start"] = {
                "dateTime": updates["start_time"].isoformat(),
                "timeZone": "UTC"
            }

        # ✅ End time
        if "end_time" in updates:
            payload["end"] = {
                "dateTime": updates["end_time"].isoformat(),
                "timeZone": "UTC"
            }

        response = requests.patch(
            url,
            json=payload,
            headers={"Authorization": f"Bearer {token}"}
        )

        if response.status_code not in [200, 202]:
            detail = _graph_error_detail(response, "Outlook update failed")
            logger.error("❌ %s", detail)
            if raise_on_error and response.status_code not in [404, 410]:
                raise RuntimeError(detail)

        return response.status_code

    # ==================================================
    # ✅ CREATE EVENT
    # ==================================================
    def create_event(self, token, event_payload, raise_on_error: bool = False):
        url = f"{GRAPH_BASE_URL}/me/events"

        payload = {
            "subject": event_payload.get("title") or "Untitled Event",
        }

        if event_payload.get("description"):
            payload["body"] = {
                "contentType": "HTML",
                "content": event_payload["description"],
            }

        start_time = event_payload.get("start_time")
        if start_time:
            payload["start"] = {
                "dateTime": start_time.isoformat(),
                "timeZone": "UTC",
            }

        end_time = event_payload.get("end_time")
        if end_time:
            payload["end"] = {
                "dateTime": end_time.isoformat(),
                "timeZone": "UTC",
            }

        response = requests.post(
            url,
            json=payload,
            headers={"Authorization": f"Bearer {token}"}
        )

        if response.status_code not in [200, 201, 202]:
            detail = _graph_error_detail(response, "Outlook create failed")
            logger.error("❌ %s", detail)
            if raise_on_error:
                raise RuntimeError(detail)
            return None

        response_payload = {}
        try:
            response_payload = response.json() or {}
        except (ValueError, AttributeError) as exc:
            logger.warning("⚠️ Outlook create response payload could not be parsed: %s", exc)

        event_id = None
        if isinstance(response_payload, dict):
            event_id = str(response_payload.get("id") or "").strip() or None
        if event_id:
            return event_id

        header_candidates = [
            response.headers.get("OData-EntityId"),
            response.headers.get("Location"),
            response.headers.get("Content-Location"),
        ]
        for header_value in header_candidates:
            event_id = _extract_event_id_from_location(header_value)
            if event_id:
                return event_id

        event_id = self._resolve_recent_created_event_id(token=token, event_payload=event_payload)
        if event_id:
            logger.info("Recovered Microsoft created-event id via fallback lookup.")
            return event_id

        logger.warning("⚠️ Outlook create succeeded but no event id could be resolved.")
        return None

    def _resolve_recent_created_event_id(self, token, event_payload):
        """Fallback for cases where Graph create succeeds but returns no event id."""
        start_dt = _parse_iso_utc(event_payload.get("start_time"))
        end_dt = _parse_iso_utc(event_payload.get("end_time"))
        if not start_dt:
            return None

        title = str(event_payload.get("title") or "").strip()
        window_start = (start_dt - timedelta(hours=2)).isoformat()
        window_end = ((end_dt or start_dt) + timedelta(hours=2)).isoformat()

        url = f"{GRAPH_BASE_URL}/me/calendarView"
        params = {
            "startDateTime": window_start,
            "endDateTime": window_end,
            "$top": 100,
            "$orderby": "createdDateTime desc",
        }
        response = requests.get(url, params=params, headers={"Authorization": f"Bearer {token}"})
        if response.status_code != 200:
            logger.warning("Fallback lookup after Outlook create could not fetch calendar view: %s", response.status_code)
            return None

        try:
            items = (response.json() or {}).get("value") or []
        except Exception:
            return None

        for item in items:
            if not isinstance(item, dict):
                continue
            candidate_id = str(item.get("id") or "").strip()
            if not candidate_id:
                continue

            if title:
                subject = str(item.get("subject") or "").strip()
                if subject != title:
                    continue

            item_start = _parse_iso_utc((item.get("start") or {}).get("dateTime"))
            if item_start is None:
                continue
            if abs((item_start - start_dt).total_seconds()) > 180:
                continue

            if end_dt is not None:
                item_end = _parse_iso_utc((item.get("end") or {}).get("dateTime"))
                if item_end is None:
                    continue
                if abs((item_end - end_dt).total_seconds()) > 180:
                    continue

            return candidate_id

        return None

    # ==================================================
    # ✅ DELETE EVENT
    # ==================================================

    def delete_event(self, token, event_id):
        """
        ✅ PURPOSE:
        Delete Outlook event
        """

        url = f"{GRAPH_BASE_URL}/me/events/{event_id}"

        response = requests.delete(
            url,
            headers={"Authorization": f"Bearer {token}"}
        )

        if response.status_code not in [200, 204]:
            logger.error("❌ Outlook delete failed: %s", response.text)

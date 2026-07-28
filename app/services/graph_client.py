
# ==================================================
# ✅ IMPORTS
# ==================================================

import logging
import requests

logger = logging.getLogger(__name__)


# ==================================================
# ✅ CONSTANTS
# ==================================================

GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0"


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

    def update_event(self, token, event_id, updates):
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
            if response.status_code not in [404, 410]:
                raise RuntimeError(detail)

        return response.status_code

    # ==================================================
    # ✅ CREATE EVENT
    # ==================================================
    def create_event(self, token, event_payload):
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

        if response.status_code not in [200, 201]:
            detail = _graph_error_detail(response, "Outlook create failed")
            logger.error("❌ %s", detail)
            raise RuntimeError(detail)

        try:
            return (response.json() or {}).get("id")
        except (ValueError, AttributeError) as exc:
            logger.warning("⚠️ Outlook create succeeded but response id could not be parsed: %s", exc)
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

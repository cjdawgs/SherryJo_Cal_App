
# ==================================================
# ✅ IMPORTS
# ==================================================

import requests


# ==================================================
# ✅ CONSTANTS
# ==================================================

GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0"


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
                print("❌ Microsoft calendarView failed:", response.text)
                break

            data = response.json()

            batch = data.get("value", [])
            events.extend(batch)

            # ✅ pagination support
            url = data.get("@odata.nextLink")

            # ✅ only include params first call
            params = None

        return {"value": events}

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
            print("❌ Outlook update failed:", response.text)

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
            print("❌ Outlook delete failed:", response.text)

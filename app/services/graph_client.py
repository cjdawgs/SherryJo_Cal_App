
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

    def get_events_with_token(self, access_token):
        """
        ✅ PURPOSE:
        Fetch all Outlook calendar events for a single account

        ✅ SAFE DESIGN:
        - never crashes system
        - returns empty list on failure
        """

        url = f"{GRAPH_BASE_URL}/me/events"

        headers = {
            "Authorization": f"Bearer {access_token}"
        }

        response = requests.get(url, headers=headers)

        # ✅ FAIL SAFE (DO NOT BREAK ENTIRE SYNC)
        if response.status_code != 200:
            print("❌ Microsoft events fetch failed:", response.text)
            return {"value": []}

        return response.json()

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

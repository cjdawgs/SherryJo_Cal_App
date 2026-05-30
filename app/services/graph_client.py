# ==================================================
# IMPORTS
# ==================================================

import requests
import time
from app.auth.token_handler import TokenHandler


# ==================================================
# CONSTANTS
# ==================================================

GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0"


# ==================================================
# GRAPH CLIENT
# ==================================================

class GraphClient:
    """
    Microsoft Graph API Client

    Responsibilities:
    - Handle authentication (via TokenHandler ✅ FIXED)
    - Send HTTP requests to Graph API
    - Handle pagination automatically ✅ KEPT
    - Provide clean methods for services layer ✅ KEPT

    Design:
    Router → Service → GraphClient → Microsoft Graph API
    """

    def __init__(self):
        # ✅ Still use TokenHandler (but now DB-based)
        self.token_handler = TokenHandler()

    # ==================================================
    # ✅ NEW TOKEN SYSTEM (USER-AWARE)
    # ==================================================

    def _get_valid_token(self, db, user):
        """
        ✅ NEW:
        Get token from DB (NOT memory)
        Auto-refresh if expired
        """

        if not user.ms_access_token:
            return None

        # ✅ Auto refresh if expired
        if user.ms_token_expires and time.time() >= user.ms_token_expires:
            self.token_handler.refresh_access_token(db, user)

        return user.ms_access_token

    # ==================================================
    # ✅ UPDATED HEADERS (ONLY THIS CHANGED)
    # ==================================================

    def _get_headers(self, db, user):
        """
        Build request headers with Bearer token
        ✅ NOW USER-AWARE
        """
        access_token = self._get_valid_token(db, user)

        if not access_token:
            raise Exception("No valid access token available for user")

        return {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        }

    # ==================================================
    # ✅ UPDATED GET WRAPPER
    # ==================================================

    def _get(self, url: str, db, user):
        """
        Internal GET wrapper with error handling
        ✅ Now uses user-specific token
        """
        response = requests.get(url, headers=self._get_headers(db, user))

        if response.status_code != 200:
            raise Exception(
                f"Graph API request failed: {response.status_code} - {response.text}"
            )

        return response.json()

    # ==================================================
    # ✅ UPDATED PAGINATION
    # ==================================================

    def _paginate(self, url: str, db, user):
        """
        Handles Graph API pagination automatically
        ✅ KEPT EXACTLY SAME LOGIC
        """
        results = []

        while url:
            data = self._get(url, db, user)

            results.extend(data.get("value", []))

            url = data.get("@odata.nextLink")

        return results

    
    # ==================================================
    # EVENTS (UPDATED SIGNATURE ONLY)
    # ==================================================

    def get_events(self, db, user):
        url = f"{GRAPH_BASE_URL}/me/events"
        return self._get(url, db, user)

    def get_all_events(self, db, user):
        url = f"{GRAPH_BASE_URL}/me/events"
        events = self._paginate(url, db, user)

        return {"value": events}
    
    def get_events_with_token(self, access_token):
        
        """
        ✅ Fetch Microsoft events per account
        """
        url = "https://graph.microsoft.com/v1.0/me/events"
        headers = {"Authorization": f"Bearer {access_token}"}

        response = requests.get(url, headers=headers)

        if response.status_code != 200:
            print("❌ Graph error:", response.text)
            raise Exception(response.text)

        return response.json()

    # ==================================================
    # TASKS
    # ==================================================

    def get_tasks(self, db, user):
        url = f"{GRAPH_BASE_URL}/me/todo/lists"
        return self._get(url, db, user)

    def get_all_tasks(self, db, user):
        task_lists = self.get_tasks(db, user).get("value", [])
        all_tasks = []

        for task_list in task_lists:
            list_id = task_list.get("id")
            url = f"{GRAPH_BASE_URL}/me/todo/lists/{list_id}/tasks"

            tasks = self._paginate(url, db, user)

            for t in tasks:
                t["list_id"] = list_id

            all_tasks.extend(tasks)

        return {"value": all_tasks}


    def update_event(self, token, event_id, updates):
        """
        ✅ PURPOSE:
        Update an event in Microsoft Outlook (Graph API)

        ✅ INPUTS:
        - token → user's Microsoft access token
        - event_id → Outlook event ID
        - updates → fields we want to change

        ✅ API:
        Microsoft Graph API
        """

        # ✅ Microsoft endpoint for updating events
        url = f"https://graph.microsoft.com/v1.0/me/events/{event_id}"

        payload = {}

        # ✅ Outlook calls title "subject"
        if "title" in updates:
            payload["subject"] = updates["title"]

        # ✅ Update start time (MUST include timezone)
        if "start_time" in updates:
            payload["start"] = {
                "dateTime": updates["start_time"].isoformat(),
                "timeZone": "UTC"  # ✅ Safe default
            }

        # ✅ Update end time
        if "end_time" in updates:
            payload["end"] = {
                "dateTime": updates["end_time"].isoformat(),
                "timeZone": "UTC"
            }

        # ✅ Send update request
        response = requests.patch(
            url,
            json=payload,
            headers={
                "Authorization": f"Bearer {token}"
            }
        )

        # ✅ Debugging
        if response.status_code not in [200, 202]:
            print("❌ Outlook update failed:", response.text)



    def delete_event(self, token, event_id):
        """
        ✅ PURPOSE:
        Delete event from Outlook calendar

        ✅ WHAT HAPPENS:
        Removes event permanently from user's Outlook calendar
        """

        url = f"https://graph.microsoft.com/v1.0/me/events/{event_id}"

        response = requests.delete(
            url,
            headers={
                "Authorization": f"Bearer {token}"
            }
        )

        # ✅ Debugging
        if response.status_code not in [200, 204]:
            print("❌ Outlook delete failed:", response.text)
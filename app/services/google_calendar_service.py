# ==================================================
# IMPORTS
# ==================================================
import time
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional
import requests
from app.config import settings


# ==================================================
# GOOGLE CALENDAR SERVICE
# ==================================================

class GoogleCalendarService:
    """
    Handles:
    - Google OAuth login URL
    - Token exchange
    - Token refresh
    - Fetching calendar events
    """

    AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
    TOKEN_URL = "https://oauth2.googleapis.com/token"

    SCOPES = [
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/userinfo.email",
    ]

    # ==================================================
    # BUILD AUTH URL ✅ FIXED
    # ==================================================
    def build_auth_url(self, state: str) -> str:
        """
        Build Google OAuth URL with state tracking
        ✅ FIX 1: use proper "&" NOT "&amp;"
        ✅ FIX 2: include state correctly
        """

        # ✅ Join scopes correctly
        scope_str = " ".join(self.SCOPES) + " openid"

        url = (
            f"{self.AUTH_URL}"
            f"?client_id={settings.GOOGLE_CLIENT_ID}"
            f"&redirect_uri={settings.GOOGLE_REDIRECT_URI}"
            f"&response_type=code"
            f"&scope={scope_str}"
            f"&access_type=offline"
            f"&prompt=consent"
            f"&state={state}"   # ✅ CRITICAL — THIS FIXES YOUR ISSUE
        )

        # ✅ Debug (WATCH THIS IN CONSOLE)
        print("✅ GOOGLE AUTH URL:", url)

        return url

    # ==================================================
    # EXCHANGE CODE FOR TOKEN
    # ==================================================
    def exchange_code(self, code: str) -> Dict[str, Any]:
        """
        Exchange auth code for access + refresh tokens
        """

        payload = {
            "code": code,
            "client_id": settings.GOOGLE_CLIENT_ID,
            "client_secret": settings.GOOGLE_CLIENT_SECRET,
            "redirect_uri": settings.GOOGLE_REDIRECT_URI,
            "grant_type": "authorization_code",
        }

        response = requests.post(self.TOKEN_URL, data=payload)

        if response.status_code != 200:
            raise Exception(f"Google token exchange failed: {response.text}")

        return response.json()

    # ==================================================
    # REFRESH ACCESS TOKEN
    # ==================================================
    def refresh_token(self, refresh_token: str) -> Dict[str, Any]:
        """
        Use refresh token to get new access token
        """

        payload = {
            "client_id": settings.GOOGLE_CLIENT_ID,
            "client_secret": settings.GOOGLE_CLIENT_SECRET,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        }

        response = requests.post(self.TOKEN_URL, data=payload)

        if response.status_code != 200:
            raise Exception(f"Google token refresh failed: {response.text}")

        return response.json()

    # ==================================================
    # FETCH EVENTS
    # ==================================================
    
    from typing import Optional

    def fetch_events(
        self,
        access_token: str,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None
    ) -> List[Dict[str, Any]]:

        """
        Fetch events from user's primary Google Calendar
        """

        headers = {
            "Authorization": f"Bearer {access_token}",
        }

        
        params = {
            "singleEvents": True,
            "orderBy": "startTime"
        }

        # ✅ APPLY DATE FILTERS
        if start_date:
            params["timeMin"] = start_date.isoformat() + "Z"

        if end_date:
            params["timeMax"] = end_date.isoformat() + "Z"

        response = requests.get(
            "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            headers=headers,
            params=params
        )


        if response.status_code != 200:
            raise Exception(f"Google events fetch failed: {response.text}")

        return response.json().get("items", [])
    
    # ==================================================
    # PUBLIC API (USED BY SYNC + TESTS)
    # ==================================================
    def get_events(self, access_token: str, start_date=None, end_date=None) -> List[Dict[str, Any]]:
        """
        ✅ PURPOSE:
        Public method used by sync engine and tests

        ✅ WHY THIS EXISTS:
        - Tests expect get_events()
        - Allows internal flexibility (can change fetch_events later)

        ✅ WHAT IT DOES:
        Calls fetch_events internally
        """

        return self.fetch_events(access_token, start_date, end_date)

    def update_event(self, token, event_id, updates):
        """
        ✅ PURPOSE:
        Update an existing event in Google Calendar

        ✅ INPUTS:
        - token → user's Google access token (used for authentication)
        - event_id → the Google event ID (stored in external_ids)
        - updates → dictionary with new values (title, start_time, end_time)

        ✅ WHAT HAPPENS:
        Sends a PATCH request to Google Calendar API to update the event
        """

        # ✅ This is the Google endpoint for updating ONE event
        url = f"https://www.googleapis.com/calendar/v3/calendars/primary/events/{event_id}"

        # ✅ This payload will contain ONLY the fields we want to update
        payload = {}

        # ✅ Update title in Google (called "summary" in Google)
        if "title" in updates:
            payload["summary"] = updates["title"]

        # ✅ Update start time
        # Google expects ISO format (YYYY-MM-DDTHH:MM:SS)
        if "start_time" in updates:
            payload["start"] = {
                "dateTime": updates["start_time"].isoformat()
            }

        # ✅ Update end time
        if "end_time" in updates:
            payload["end"] = {
                "dateTime": updates["end_time"].isoformat()
            }

        # ✅ Send request to Google API
        response = requests.patch(
            url,
            json=payload,
            headers={
                "Authorization": f"Bearer {token}"
            }
        )

        # ✅ Optional: Debugging (VERY helpful while testing)
        if response.status_code not in [200, 204]:
            print("❌ Google update failed:", response.text)



    def delete_event(self, token, event_id):
        """
        ✅ PURPOSE:
        Delete an event from Google Calendar

        ✅ INPUTS:
        - token → user's Google access token
        - event_id → the Google event ID

        ✅ WHAT HAPPENS:
        Sends DELETE request to remove event permanently
        """

        url = f"https://www.googleapis.com/calendar/v3/calendars/primary/events/{event_id}"

        response = requests.delete(
            url,
            headers={
                "Authorization": f"Bearer {token}"
            }
        )

        # ✅ Debugging
        if response.status_code not in [200, 204]:
            print("❌ Google delete failed:", response.text)


    # ==================================================
    # Get User Email from Google
    # ==================================================
    def get_user_info(self, access_token: str) -> Dict[str, Any]:
        """
        Get user's Google email
        """

        headers = {
            "Authorization": f"Bearer {access_token}"
        }

        response = requests.get(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            headers=headers
        )

        if response.status_code != 200:
            raise Exception(f"Failed to fetch user info: {response.text}")

        return response.json()

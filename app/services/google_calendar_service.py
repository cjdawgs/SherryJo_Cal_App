
# ==================================================
# ✅ IMPORTS
# ==================================================
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
import requests
from app.config import settings


# ==================================================
# ✅ GOOGLE CALENDAR SERVICE (FINAL)
# ==================================================

class GoogleCalendarService:
    """
    ✅ RESPONSIBILITIES:
    - Build Google OAuth URL
    - Exchange code → tokens
    - Refresh access tokens
    - Fetch user calendar events

    ✅ DESIGN:
    This class DOES NOT manage token lifecycle logic.
    That is handled by:
        ensure_valid_token()

    ✅ THIS FILE ONLY:
    - Talks to Google APIs
    - Returns clean responses
    """

    AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
    TOKEN_URL = "https://oauth2.googleapis.com/token"

    SCOPES = [
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/userinfo.email",
        "openid"
    ]

    # ==================================================
    # ✅ BUILD AUTH URL (CRITICAL FIXES INCLUDED)
    # ==================================================
    def build_auth_url(self, state: str) -> str:
        """
        ✅ PURPOSE:
        Generates Google OAuth login URL

        ✅ CRITICAL SETTINGS:
        - access_type=offline → REQUIRED for refresh_token
        - prompt=consent → forces refresh_token return
        - state → tracks which account/user login belongs to

        ✅ DO NOT REMOVE THESE PARAMS
        """

        scope_str = " ".join(self.SCOPES)

        # ✅ FIXED: use "&" NOT "&amp;"
        url = (
            f"{self.AUTH_URL}"
            f"?client_id={settings.GOOGLE_CLIENT_ID}"
            f"&redirect_uri={settings.GOOGLE_REDIRECT_URI}"
            f"&response_type=code"
            f"&scope={scope_str}"
            f"&access_type=offline"
            f"&prompt=consent"
            f"&state={state}"
        )

        print("✅ GOOGLE AUTH URL:", url)

        return url

    # ==================================================
    # ✅ EXCHANGE CODE → TOKENS
    # ==================================================
    def exchange_code(self, code: str) -> Dict[str, Any]:
        """
        ✅ PURPOSE:
        Exchange authorization code for tokens

        ✅ RETURNS:
        {
            access_token,
            refresh_token (IMPORTANT),
            expires_in
        }

        ✅ IMPORTANT:
        Sometimes Google does NOT return refresh_token
        unless consent is forced — we log that case.
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
            raise Exception(f"❌ Google token exchange failed: {response.text}")

        data = response.json()

        # ✅ CRITICAL DEBUG
        if "refresh_token" not in data:
            print("🚨 WARNING: Google did NOT return refresh_token")
            print("➡️ User may need to reconnect with consent")

        return data

    # ==================================================
    # ✅ REFRESH TOKEN
    # ==================================================
    def refresh_token(self, refresh_token: str) -> Dict[str, Any]:
        """
        ✅ PURPOSE:
        Get a new access_token using refresh_token

        ✅ CALLED BY:
        ensure_valid_token() (NOT directly by you)
        """

        payload = {
            "client_id": settings.GOOGLE_CLIENT_ID,
            "client_secret": settings.GOOGLE_CLIENT_SECRET,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        }

        response = requests.post(self.TOKEN_URL, data=payload)

        if response.status_code != 200:
            print("❌ Google refresh failed:", response.text)
            return {}

        return response.json()

    # ==================================================
    # ✅ FETCH EVENTS (SAFE VERSION)
    # ==================================================
    def fetch_events(
        self,
        access_token: str,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None
    ) -> List[Dict[str, Any]]:
        """
        ✅ PURPOSE:
        Fetch events from Google Calendar

        ✅ SAFE DESIGN:
        - Never throws fatal exception
        - Returns [] on failure
        """

        headers = {
            "Authorization": f"Bearer {access_token}",
        }

        params = {
            "singleEvents": True,
            "orderBy": "startTime",
            "maxResults": 2500   # ✅ prevents truncation
        }

        # ✅ FORCE UTC (CRITICAL FIX)
        if start_date:
            if start_date.tzinfo is None:
                start_date = start_date.replace(tzinfo=timezone.utc)
            params["timeMin"] = start_date.isoformat()

        if end_date:
            if end_date.tzinfo is None:
                end_date = end_date.replace(tzinfo=timezone.utc)
            params["timeMax"] = end_date.isoformat()

        response = requests.get(
            "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            headers=headers,
            params=params
        )

        # ✅ SAFE FAILURE (DO NOT CRASH SYSTEM)
        if response.status_code != 200:
            print("❌ Google events fetch failed:", response.text)
            return []

        return response.json().get("items", [])

    # ==================================================
    # ✅ PUBLIC WRAPPER (FOR CONSISTENCY)
    # ==================================================
    def get_events(self, access_token: str, start_date=None, end_date=None):
        """
        ✅ Exists for consistency
        (some systems expect this method name)
        """
        return self.fetch_events(access_token, start_date, end_date)

    # ==================================================
    # ✅ UPDATE EVENT
    # ==================================================
    def update_event(self, token, event_id, updates):
        url = f"https://www.googleapis.com/calendar/v3/calendars/primary/events/{event_id}"

        payload = {}

        if "title" in updates:
            payload["summary"] = updates["title"]

        if "start_time" in updates:
            payload["start"] = {"dateTime": updates["start_time"].isoformat()}

        if "end_time" in updates:
            payload["end"] = {"dateTime": updates["end_time"].isoformat()}

        response = requests.patch(
            url,
            json=payload,
            headers={"Authorization": f"Bearer {token}"}
        )

        if response.status_code not in [200, 204]:
            print("❌ Google update failed:", response.text)

    # ==================================================
    # ✅ DELETE EVENT
    # ==================================================
    def delete_event(self, token, event_id):
        url = f"https://www.googleapis.com/calendar/v3/calendars/primary/events/{event_id}"

        response = requests.delete(
            url,
            headers={"Authorization": f"Bearer {token}"}
        )

        if response.status_code not in [200, 204]:
            print("❌ Google delete failed:", response.text)

    # ==================================================
    # ✅ GET USER EMAIL
    # ==================================================
    def get_user_info(self, access_token: str) -> Dict[str, Any]:
        headers = {"Authorization": f"Bearer {access_token}"}

        response = requests.get(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            headers=headers
        )

        if response.status_code != 200:
            raise Exception(f"Failed to fetch user info: {response.text}")

        return response.json()

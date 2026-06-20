
# ==================================================
# ✅ IMPORTS
# ==================================================
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
import requests
from app.config import settings
from app.config import get_google_redirect_uri


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
        "https://www.googleapis.com/auth/calendar"
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
            f"&redirect_uri={get_google_redirect_uri()}"
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
    def exchange_code(self, code: str, redirect_uri: str | None = None) -> Dict[str, Any]:
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
            "redirect_uri": redirect_uri or get_google_redirect_uri(),
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
        access_token, 
        account_email=None, 
        start_date=None, 
        end_date=None
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

        calendar_id = account_email or "primary"

        # ✅ STEP 1: GET ALL CALENDARS
        cal_list_resp = requests.get(
            "https://www.googleapis.com/calendar/v3/users/me/calendarList",
            headers=headers
        )

        calendars = []

        if cal_list_resp.status_code == 200:
            calendars = cal_list_resp.json().get("items", [])
        else:
            print("⚠️ Calendar list failed — falling back to direct calendars")

        # ✅ ALWAYS include these (critical)
        calendar_ids = ["primary"]

        if account_email and account_email != "primary":
            calendar_ids.append(account_email.lower())

        #/**************************************************************
        #* ✅ HARD FILTER SYSTEM CALENDARS (CRITICAL FIX)
        #* Prevents Google holiday + system calendar failures
        #**************************************************************/
        for c in calendars:
            cid = (c.get("id") or "").lower()

            if not cid:
                continue

            # ✅ BLOCK ALL SYSTEM CALENDARS
            if (
                "holiday" in cid or
                "@group.v.calendar.google.com" in cid or
                "#" in cid   # ✅ catches regional calendars like en.usa#
            ):
                print(f"⏭ Skipping system calendar at source: {cid}")
                continue

            if cid not in calendar_ids:
                calendar_ids.append(cid)        
                
        print("🧪 CALENDAR IDS USED:", calendar_ids)

        all_events = []

        # ✅ STEP 2: FETCH EVENTS FROM EACH CALENDAR
        for cal_id in calendar_ids:
            cid = (cal_id or "").lower()

            if (
                "holiday" in cid or
                "@group.v.calendar.google.com" in cid or
                "#" in cid
            ):
                print(f"⏭ Skipping bad calendar at request time: {cid}")
                continue

            print(f"📆 CALENDAR ID ({account_email}):", cal_id)
            url = f"https://www.googleapis.com/calendar/v3/calendars/{cal_id}/events"

            
            response = requests.get(
                    url,
                    headers=headers,
                    params=params
                )

            if response.status_code != 200:
                print(f"❌ Failed ({response.status_code}): {cal_id}")

                try:
                    print("↳ Response:", response.text[:200])
                except:
                    pass

                continue

            items = response.json().get("items", [])

            print(f"📦 Events in {cal_id}:", len(items))

            all_events.extend(items)


        print(f"🟢 Google TOTAL events fetched ({account_email}):", len(all_events))

        return all_events
        
    # ==================================================
    # ✅ PUBLIC WRAPPER (FOR CONSISTENCY)
    # ==================================================
    def get_events(self, access_token: str, account_email=None, start_date=None, end_date=None):
        return self.fetch_events(
            access_token=access_token,
            account_email=account_email,
            start_date=start_date,
            end_date=end_date
        )

    # ==================================================
    # ✅ UPDATE EVENT
    # ==================================================
    def update_event(self, token, event_id, updates, account_email=None):
        calendar_id = account_email or "primary"
        url = f"https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events/{event_id}"
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
    def delete_event(self, token, event_id, account_email=None):
        
        calendar_id = account_email or "primary"
        url = f"https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events/{event_id}"
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

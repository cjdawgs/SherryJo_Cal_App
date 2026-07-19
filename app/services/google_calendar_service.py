
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
        "https://www.googleapis.com/auth/calendar",
        "openid",
        "email",
        "profile",
    ]
    REQUEST_TIMEOUT = (5, 15)

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
            headers=headers,
            timeout=self.REQUEST_TIMEOUT,
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
                    params=params,
                    timeout=self.REQUEST_TIMEOUT,
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
    # ✅ INCREMENTAL FETCH (V2)
    # Uses syncToken per calendar when available; full fetch with
    # date range otherwise.  Returns a structured result dict so
    # the caller can store new tokens and handle cancellations.
    # ==================================================
    def fetch_events_v2(
        self,
        access_token: str,
        account_email: str = None,
        start_date=None,
        end_date=None,
        sync_token_state: dict = None,   # {cal_id: syncToken}
    ) -> dict:
        """
        Returns:
            {
              "events":          [event_dict, ...],   # active events only
              "cancelled_ids":   ["raw_event_id", ...],  # deleted since last sync
              "next_tokens":     {cal_id: nextSyncToken},  # store back in DB
              "used_incremental": bool,
            }
        """
        headers = {"Authorization": f"Bearer {access_token}"}
        sync_state = dict(sync_token_state or {})
        next_tokens: dict = {}
        all_events: list = []
        cancelled_ids: list = []
        used_incremental = False

        # ── discover calendars ──────────────────────────────────────────
        calendar_ids = ["primary"]
        if account_email and account_email.lower() != "primary":
            calendar_ids.append(account_email.lower())

        try:
            cl_resp = requests.get(
                "https://www.googleapis.com/calendar/v3/users/me/calendarList",
                headers=headers,
                timeout=self.REQUEST_TIMEOUT,
            )
            if cl_resp.status_code == 200:
                for c in cl_resp.json().get("items", []):
                    cid = (c.get("id") or "").lower()
                    if not cid:
                        continue
                    if "holiday" in cid or "@group.v.calendar.google.com" in cid or "#" in cid:
                        continue
                    if cid not in calendar_ids:
                        calendar_ids.append(cid)
        except Exception as e:
            print(f"⚠️ Google calendarList failed: {e}")

        # ── fetch each calendar (incremental when token available) ──────
        start_iso = start_date.isoformat() if start_date else None
        end_iso   = end_date.isoformat()   if end_date   else None

        for cal_id in calendar_ids:
            cid_lower = cal_id.lower()
            if "holiday" in cid_lower or "@group.v.calendar.google.com" in cid_lower or "#" in cid_lower:
                continue

            token_for_cal = sync_state.get(cal_id)

            # Try incremental; fall back to full on 410 GONE
            for attempt in range(2):
                if token_for_cal and attempt == 0:
                    # Incremental: syncToken, no date range
                    params: dict = {"syncToken": token_for_cal, "singleEvents": True, "maxResults": 2500}
                    used_incremental = True
                else:
                    # Full fetch with date range
                    params = {"singleEvents": True, "orderBy": "startTime", "maxResults": 2500}
                    if start_iso:
                        params["timeMin"] = start_iso
                    if end_iso:
                        params["timeMax"] = end_iso
                    token_for_cal = None  # clear so next calendar starts fresh

                url = f"https://www.googleapis.com/calendar/v3/calendars/{cal_id}/events"
                items: list = []
                next_sync_token = None
                need_retry = False

                # paginate
                while url:
                    resp = requests.get(url, headers=headers, params=params, timeout=self.REQUEST_TIMEOUT)

                    if resp.status_code == 410:
                        # syncToken expired → retry as full fetch
                        need_retry = True
                        break

                    if resp.status_code != 200:
                        print(f"❌ Google events failed ({resp.status_code}): {cal_id}")
                        break

                    data = resp.json()
                    items.extend(data.get("items", []))

                    page_token = data.get("nextPageToken")
                    if page_token:
                        params = dict(params)   # copy to avoid mutation
                        params["pageToken"] = page_token
                        params.pop("syncToken", None)
                        url = f"https://www.googleapis.com/calendar/v3/calendars/{cal_id}/events"
                    else:
                        next_sync_token = data.get("nextSyncToken")
                        url = None

                if need_retry:
                    # Loop again (attempt==1) with full fetch
                    continue

                # Separate active from cancelled
                for item in items:
                    if item.get("status") == "cancelled":
                        raw_id = item.get("id")
                        if raw_id:
                            cancelled_ids.append(raw_id)
                    else:
                        all_events.append(item)

                if next_sync_token:
                    next_tokens[cal_id] = next_sync_token

                break  # done with this calendar

        return {
            "events":           all_events,
            "cancelled_ids":    cancelled_ids,
            "next_tokens":      next_tokens,
            "used_incremental": used_incremental,
        }

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

        return response.status_code

    # ==================================================
    # ✅ CREATE EVENT
    # ==================================================
    def create_event(self, token, event_payload, account_email=None):
        calendar_id = account_email or "primary"
        url = f"https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events"

        payload = {
            "summary": event_payload.get("title") or "Untitled Event",
        }

        if event_payload.get("description"):
            payload["description"] = event_payload["description"]

        start_time = event_payload.get("start_time")
        if start_time:
            payload["start"] = {"dateTime": start_time.isoformat()}

        end_time = event_payload.get("end_time")
        if end_time:
            payload["end"] = {"dateTime": end_time.isoformat()}

        response = requests.post(
            url,
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
            timeout=self.REQUEST_TIMEOUT,
        )

        if response.status_code not in [200, 201]:
            print("❌ Google create failed:", response.text)
            return None

        try:
            return (response.json() or {}).get("id")
        except Exception:
            return None

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
            headers=headers,
            timeout=self.REQUEST_TIMEOUT,
        )

        if response.status_code != 200:
            raise Exception(f"Failed to fetch user info: {response.text}")

        return response.json()

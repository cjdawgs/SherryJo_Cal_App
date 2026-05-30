import time
import requests
import os

CLIENT_ID = os.getenv("MS_CLIENT_ID")
CLIENT_SECRET = os.getenv("MS_CLIENT_SECRET")
TENANT_ID = os.getenv("MS_TENANT_ID")

AUTHORITY = f"https://login.microsoftonline.com/{TENANT_ID}"
TOKEN_URL = f"{AUTHORITY}/oauth2/v2.0/token"


class TokenHandler:
    def __init__(self):
        self.token_data = None  # Replace with DB later

    def store_tokens(self, token_response: dict):
        self.token_data = {
            "access_token": token_response.get("access_token"),
            "refresh_token": token_response.get("refresh_token"),
            "expires_at": time.time() + token_response.get("expires_in", 3600)
        }

    def get_access_token(self, *args, **kwargs):
        """
        Returns valid access token.
        If expired → triggers refresh.
        """

        if not self.token_data:
            return None

        expires_at = self.token_data.get("expires_at")

        # ✅ ✅ KEY FIX: correct expiration check
        current_time = time.time()

        if not expires_at or current_time >= expires_at:
            # Token expired → refresh
            new_token = self.refresh_access_token(*args, **kwargs)

            # ✅ OPTIONAL but recommended: update stored token
            if new_token:
                self.token_data["access_token"] = new_token
                return new_token

        return self.token_data["access_token"]

    def refresh_access_token(self, db, user):
        if not user.ms_refresh_token:
            return None

        data = {
            "client_id": CLIENT_ID,
            "grant_type": "refresh_token",
            "refresh_token": user.ms_refresh_token,
            "client_secret": CLIENT_SECRET,
            "scope": "User.Read Calendars.Read Tasks.Read offline_access"
        }

        response = requests.post(TOKEN_URL, data=data)

        if response.status_code == 200:
            new_tokens = response.json()

            user.ms_access_token = new_tokens.get("access_token")
            user.ms_token_expires = time.time() + new_tokens.get("expires_in", 3600)

            db.commit()

            return user.ms_access_token

        return None

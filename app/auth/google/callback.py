from fastapi import Request
from fastapi.responses import RedirectResponse
import requests

GOOGLE_CLIENT_SECRET = "YOUR_CLIENT_SECRET"

@router.get("/auth/google/callback")
def google_callback(request: Request):

    code = request.query_params.get("code")

    token_url = "https://oauth2.googleapis.com/token"

    data = {
        "code": code,
        "client_id": GOOGLE_CLIENT_ID,
        "client_secret": GOOGLE_CLIENT_SECRET,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code",
    }

    token_res = requests.post(token_url, data=data)
    tokens = token_res.json()

    access_token = tokens.get("access_token")
    refresh_token = tokens.get("refresh_token")

    # ✅ IMPORTANT: SAVE THESE TO YOUR DB WITH user_id

    # Example:
    # save_account(user_id, "google", access_token, refresh_token)

    return RedirectResponse("/calendar-ui?connected=google")

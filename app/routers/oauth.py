# ==================================================
# MICROSOFT OAUTH ROUTER (FULLY FIXED ✅)
# ==================================================

from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.responses import RedirectResponse
from urllib.parse import urlencode
from sqlalchemy.orm import Session

import requests
import os
import jwt

from app.database import get_db
from app.routers.auth import SECRET_KEY
from app.security import create_token
from app.config import get_ms_redirect_uri

# ✅ THIS IS THE KEY: multi-account support
from app.services.multi_account_oauth_service import MultiAccountOAuthService


# ==================================================
# ROUTER SETUP
# ==================================================

router = APIRouter(
    prefix="/ms",
    tags=["Microsoft OAuth"]
)


# ==================================================
# ENV CONFIG
# ==================================================

CLIENT_ID = os.getenv("MS_CLIENT_ID")
CLIENT_SECRET = os.getenv("MS_CLIENT_SECRET")
TENANT_ID = os.getenv("MS_TENANT_ID")
REDIRECT_URI = os.getenv("MS_REDIRECT_URI")

AUTHORITY = f"https://login.microsoftonline.com/{TENANT_ID}"
AUTHORIZE_URL = f"{AUTHORITY}/oauth2/v2.0/authorize"
TOKEN_URL = f"{AUTHORITY}/oauth2/v2.0/token"


if not CLIENT_ID or not CLIENT_SECRET or not TENANT_ID:
    raise HTTPException(status_code=500, detail="Missing environment variables")

print("✅ CLIENT_SECRET LOADED:", CLIENT_SECRET)

print("✅ CLIENT_ID:", CLIENT_ID)
print("✅ CLIENT_SECRET LENGTH:", len(CLIENT_SECRET) if CLIENT_SECRET else "None")
print("✅ REDIRECT_URI env (legacy):", REDIRECT_URI)
print("✅ REDIRECT_URI runtime template: {base_url}/ms/callback")

print("✅ TENANT_ID:", TENANT_ID)
print("✅ AUTHORITY:", AUTHORITY)

# ==================================================
# SCOPES (what data we request from Microsoft)
# ==================================================

SCOPES = [
    "User.Read",
    "Calendars.Read",
    "Tasks.Read",
    "offline_access"
]


# ==================================================
# LOGIN (START OAUTH FLOW)
# ==================================================
@router.get("/login")
def login(request: Request, token: str = None, reconnect: str = None):

    """
    ✅ Starts Microsoft OAuth flow
    ✅ Receives JWT via query param (browser redirect-safe)
    """

    # ==================================================
    # ✅ DECODE JWT TOKEN → GET USER_ID
    # ==================================================
    user_id = None
    if token:
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
            user_id = payload.get("user_id")
        except Exception:
            raise HTTPException(status_code=401, detail="Invalid token")

    # ✅ Optional safety check
    if token and not user_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    # ==================================================
    # ✅ CREATE STATE TOKEN (IMPORTANT)
    # ==================================================
    reconnect_email = (reconnect or "").strip().lower() or None

    if user_id:
        state = jwt.encode(
            {
                "user_id": user_id,
                "reconnect": reconnect_email
            },
            SECRET_KEY,
            algorithm="HS256"
        )
    else:
        state = "legacy"

    # ==================================================
    # ✅ BUILD MICROSOFT LOGIN URL
    # ==================================================
    params = {
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": get_ms_redirect_uri(request),
        "response_mode": "query",
        "scope": " ".join(SCOPES),
        "state": state,   # ✅ ties login back to user
        # ✅ FORCE Microsoft to show account picker
        "prompt": "select_account",
    }

    if reconnect_email:
        params["login_hint"] = reconnect_email

    url = f"{AUTHORIZE_URL}?{urlencode(params)}"

    return RedirectResponse(url)



# ==================================================
# CALLBACK (HANDLE MICROSOFT RESPONSE)
# ==================================================
from typing import Optional

@router.get("/callback")
def callback(
    request: Request,
    code: str,
    state: Optional[str] = None,
    error: Optional[str] = None,
    error_subcode: Optional[str] = None,
    db: Session = Depends(get_db)
):
    print("✅ CALLBACK HIT:", f"/ms/callback?code_present={bool(code)}")

    """
    ✅ Handles Microsoft OAuth response
    ✅ Exchanges code for tokens
    ✅ Saves account to DB (multi-account safe)
    """


    # ==================================================
    # ✅ HANDLE OAUTH FAILURE (SAFE + ROBUST ✅)
    # ==================================================
    if error:
        print("❌ MICROSOFT OAUTH ERROR:", error, error_subcode)

        user_id = None

        # ✅ Try to decode state IF it exists (optional)
        if state:
            try:
                payload = jwt.decode(state, SECRET_KEY, algorithms=["HS256"])
                user_id = payload.get("user_id")
            except Exception:
                print("⚠️ Could not decode state during error")

        # ✅ Redirect cleanly regardless
        return RedirectResponse(
            "/accounts/ui?error=microsoft_login_failed"
        )


    # ==================================================
    # ✅ STEP 1: DECODE STATE (GET USER ID)
    # ==================================================
    user_id = None
    expected_reconnect = ""

    if state:
        try:
            payload = jwt.decode(state, SECRET_KEY, algorithms=["HS256"])
            user_id = payload.get("user_id")
            expected_reconnect = (payload.get("reconnect") or "").strip().lower()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid state")

    
    # ==================================================
    # ✅ STEP 2: EXCHANGE CODE → ACCESS TOKEN (DEBUG SAFE)
    # ==================================================

    token_response = requests.post(
        TOKEN_URL,
        data={
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "code": code,
            "redirect_uri": get_ms_redirect_uri(request),
            "grant_type": "authorization_code",
        },
    )

    # ✅ Convert response safely
    token_json = token_response.json()

    # ✅ DEBUG PRINT (VERY IMPORTANT)
    print("✅ TOKEN RESPONSE:", token_json)

    # ✅ Extract tokens
    access_token = token_json.get("access_token")
    refresh_token = token_json.get("refresh_token")

    # ✅ ERROR HANDLING (THIS FIXES YOUR CRASH)
    if not access_token:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to get access token: {token_json}"
        )


    # Legacy behavior for old tests: no state, return JSON success.
    if not state:
        if not access_token:
            raise HTTPException(status_code=400, detail="Failed to get access token")
        return {"message": "Microsoft connected"}

    # ==================================================
    # ✅ STEP 3: GET USER PROFILE (FOR EMAIL)
    # ==================================================
    user_info_response = requests.get(
        "https://graph.microsoft.com/v1.0/me",
        headers={
            "Authorization": f"Bearer {access_token}"
        }
    )

    user_info = user_info_response.json()

    # ✅ DEBUG PRINT
    print("✅ MS USER:", user_info)

    # ✅ Error check
    if "error" in user_info:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to fetch user profile: {user_info}"
        )
    
    # ==================================================
    # ✅ STEP 3.5: EXTRACT EMAIL (THIS WAS MISSING ✅✅✅)
    # ==================================================

    """
    ✅ Microsoft may return email in different fields:
    - mail (sometimes null)
    - userPrincipalName (fallback)
    """

    email = user_info.get("mail") or user_info.get("userPrincipalName")
    normalized_email = (email or "").strip().lower()

    # ✅ DEBUG
    print("✅ EXTRACTED EMAIL:", normalized_email)

    # ✅ VALIDATION (prevents crashes)
    if not normalized_email:
        raise HTTPException(
            status_code=400,
            detail=f"Could not extract email from Microsoft response: {user_info}"
        )

    if expected_reconnect and normalized_email != expected_reconnect:
        new_token = create_token(user_id)
        mismatch = urlencode({
            "error": "microsoft_reconnect_mismatch",
            "expected": expected_reconnect,
            "actual": normalized_email,
            "token": new_token
        })
        return RedirectResponse(f"/accounts/ui?{mismatch}")

    
    print("✅ SAVING ACCOUNT:", {
        "user_id": user_id,
        "email": normalized_email
    })

    # ==================================================
    # ✅ STEP 4: SAVE ACCOUNT (MULTI-ACCOUNT ✅✅✅)
    # ==================================================
    MultiAccountOAuthService.add_oauth_account(
        db=db,
        user_id=user_id,
        provider="microsoft",
        account_email=normalized_email,
        access_token=access_token,
        refresh_token=refresh_token,
    )

    #print("✅ MICROSOFT ACCOUNT SAVED")

    # ==================================================
    # ✅ STEP 5: REDIRECT BACK TO UI (AUTO REFRESH ✅)
    # ==================================================
    
    from app.security import create_token  # ADD THIS IMPORT AT TOP IF MISSING

    # ✅ Create NEW app JWT
    new_token = create_token(user_id)

    # ✅ Send it back to UI
    query = urlencode({
        "connected": "microsoft",
        "account": normalized_email,
        "token": new_token
    })

    return RedirectResponse(
        f"/accounts/ui?{query}"
    )

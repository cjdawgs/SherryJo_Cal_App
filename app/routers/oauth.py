# ==================================================
# MICROSOFT OAUTH ROUTER (FULLY FIXED ✅)
# ==================================================

import logging
from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.responses import RedirectResponse
from urllib.parse import urlencode
from sqlalchemy.orm import Session

import requests
import os

from app.database import get_db
from app.routers.auth import SECRET_KEY
from app.utils.oauth_state import (
    decode_oauth_state,
    decode_user_token,
    encode_oauth_state,
    normalize_reconnect_email,
)
from app.security import create_token
from app.config import get_ms_redirect_uri

# ✅ THIS IS THE KEY: multi-account support
from app.services.multi_account_oauth_service import MultiAccountOAuthService

logger = logging.getLogger(__name__)


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

logger.debug(
    "Microsoft OAuth configured: client_id=%s tenant=%s redirect=%s secret_present=%s",
    CLIENT_ID, TENANT_ID, REDIRECT_URI, bool(CLIENT_SECRET),
)

# ==================================================
# SCOPES (what data we request from Microsoft)
# ==================================================

SCOPES = [
    "User.Read",
    "Calendars.Read",
    "Calendars.ReadWrite",
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
            user_id = decode_user_token(token, SECRET_KEY)
        except Exception:
            raise HTTPException(status_code=401, detail="Invalid token")

    # ✅ Optional safety check
    if token and not user_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    # ==================================================
    # ✅ CREATE STATE TOKEN (IMPORTANT)
    # ==================================================
    reconnect_email = normalize_reconnect_email(reconnect)

    if user_id:
        state = encode_oauth_state(user_id, reconnect_email, SECRET_KEY)
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
        # Reconnect should force consent so upgraded scopes (e.g. ReadWrite)
        # are actually granted on existing accounts.
        "prompt": "consent" if reconnect_email else "select_account",
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
    logger.info("✅ CALLBACK HIT: %s", f"/ms/callback?code_present={bool(code)}")

    """
    ✅ Handles Microsoft OAuth response
    ✅ Exchanges code for tokens
    ✅ Saves account to DB (multi-account safe)
    """


    # ==================================================
    # ✅ HANDLE OAUTH FAILURE (SAFE + ROBUST ✅)
    # ==================================================
    if error:
        logger.error("❌ MICROSOFT OAUTH ERROR: %s %s", error, error_subcode)

        user_id = None

        # ✅ Try to decode state IF it exists (optional)
        if state:
            try:
                user_id, _ = decode_oauth_state(state, SECRET_KEY)
            except Exception:
                logger.warning("⚠️ Could not decode state during error")

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
            user_id, expected_reconnect = decode_oauth_state(state, SECRET_KEY)
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

    logger.info("✅ TOKEN RESPONSE received: %s", token_response.status_code)

    # ✅ Extract tokens
    access_token = token_json.get("access_token")
    refresh_token = token_json.get("refresh_token")
    granted_scope = str(token_json.get("scope") or "")

    # ✅ ERROR HANDLING (THIS FIXES YOUR CRASH)
    if not access_token:
        logger.error("❌ MICROSOFT TOKEN EXCHANGE FAILED: %s", token_json.get("error"))
        if user_id is not None:
            params = urlencode({
                "error": "microsoft_token_missing",
                "token": create_token(user_id),
            })
            return RedirectResponse(f"/accounts/ui?{params}")
        raise HTTPException(
            status_code=400,
            detail="Failed to get access token from Microsoft"
        )

    granted_scope_set = {part.strip() for part in granted_scope.split(" ") if part.strip()}
    if state and "Calendars.ReadWrite" not in granted_scope_set:
        logger.error("❌ MICROSOFT TOKEN MISSING REQUIRED WRITE SCOPE: granted=%s", granted_scope)
        params = urlencode({
            "error": "microsoft_scope_missing_write",
            "token": create_token(user_id),
        })
        return RedirectResponse(f"/accounts/ui?{params}")


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

    # ✅ Error check
    if "error" in user_info:
        logger.error("❌ MICROSOFT PROFILE FETCH FAILED: %s", user_info.get("error"))
        params = urlencode({
            "error": "microsoft_profile_failed",
            "token": create_token(user_id),
        })
        return RedirectResponse(f"/accounts/ui?{params}")
    
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

    # ✅ VALIDATION (prevents crashes)
    if not normalized_email:
        params = urlencode({
            "error": "microsoft_email_missing",
            "token": create_token(user_id),
        })
        return RedirectResponse(f"/accounts/ui?{params}")

    if expected_reconnect and normalized_email != expected_reconnect:
        new_token = create_token(user_id)
        mismatch = urlencode({
            "error": "microsoft_reconnect_mismatch",
            "expected": expected_reconnect,
            "actual": normalized_email,
            "token": new_token
        })
        return RedirectResponse(f"/accounts/ui?{mismatch}")

    
    logger.info("✅ SAVING ACCOUNT: %s", {
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

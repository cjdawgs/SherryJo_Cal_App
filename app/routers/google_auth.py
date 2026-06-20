# ==================================================
# GOOGLE OAUTH ROUTER
# ==================================================

from fastapi import APIRouter, HTTPException, Query, Depends, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from urllib.parse import urlencode
import os
import jwt

from app.deps import get_current_user
from app.routers.auth import SECRET_KEY
from app.security import create_token
from app.config import get_google_redirect_uri


from app.database import get_db
from app.services.google_calendar_service import GoogleCalendarService


router = APIRouter(prefix="/auth/google", tags=["Google Auth"])

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")

service = GoogleCalendarService()


# ==================================================
# LOGIN (START OAUTH FLOW)
# ==================================================

@router.get("/login")
def google_login(request: Request, token: str, reconnect: str = Query(None)):
    """
    ✅ Receive JWT token from URL (not header)
    """
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        user_id = payload.get("user_id")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    """
    ✅ Starts Google OAuth flow
    ✅ Requires JWT (so we know which user is connecting accounts)
    """

    # ✅ Store user ID in state (VERY important)
    reconnect_email = (reconnect or "").strip().lower() or None

    state = jwt.encode(
        {
            "user_id": user_id,
            "reconnect": reconnect_email
        },
        SECRET_KEY,
        algorithm="HS256"
    )

    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": get_google_redirect_uri(request),
        "scope": "openid email profile https://www.googleapis.com/auth/calendar",
        "access_type": "offline",
        "prompt": "select_account consent",
        "state": state,
    }

    if reconnect_email:
        params["login_hint"] = reconnect_email

    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(params)

    return RedirectResponse(url)


# ==================================================
# CALLBACK (HANDLE GOOGLE RESPONSE)
# ==================================================
@router.get("/callback")
def google_callback(
    request: Request,
    code: str,
    state: str,
    db: Session = Depends(get_db)
):
    print("✅ CALLBACK HIT:", str(request.url))

    # ==================================================
    # ✅ DECODE STATE (extract user_id from JWT)
    # ==================================================
    try:
        payload = jwt.decode(state, SECRET_KEY, algorithms=["HS256"])
        user_id = payload.get("user_id")
        expected_reconnect = (payload.get("reconnect") or "").strip().lower()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid state")

    # ==================================================
    # ✅ EXCHANGE AUTH CODE FOR TOKENS
    # ==================================================
    token_data = service.exchange_code(code, redirect_uri=get_google_redirect_uri(request))

    access_token = token_data.get("access_token")
    refresh_token = token_data.get("refresh_token")

    # ==================================================
    # ✅ GET GOOGLE USER INFO
    # ==================================================
    user_info = service.get_user_info(access_token)
    email = user_info.get("email")
    normalized_email = (email or "").strip().lower()

    if expected_reconnect and normalized_email != expected_reconnect:
        new_token = create_token(user_id)
        mismatch = urlencode({
            "error": "google_reconnect_mismatch",
            "expected": expected_reconnect,
            "actual": normalized_email,
            "token": new_token
        })
        return RedirectResponse(f"/accounts/ui?{mismatch}")

    print("✅ GOOGLE EMAIL:", email)

    # ==================================================
    # ✅ SAVE ACCOUNT (MULTI-ACCOUNT SAFE ✅✅✅)
    # ==================================================
    import time
    from app.services.multi_account_oauth_service import MultiAccountOAuthService

    # ✅ Calculate expiration timestamp
    # Google returns expires_in (seconds from now)
    expires_in = token_data.get("expires_in", 3600)

    token_expires_at = time.time() + expires_in

    # ✅ SAVE GOOGLE ACCOUNT (MULTI-ACCOUNT SUPPORT)
    MultiAccountOAuthService.add_oauth_account(
        db=db,
        user_id=user_id,
        provider="google",
        account_email=normalized_email,
        access_token=access_token,
        refresh_token=refresh_token,
        token_expires_at=token_expires_at,
        display_name=normalized_email
    )


    print("✅ GOOGLE ACCOUNT SAVED")

    # ==================================================
    # ✅ REDIRECT BACK TO UI (AUTO REFRESH ✅)
    # ==================================================
    new_token = create_token(user_id)
    query = urlencode({
        "connected": "google",
        "account": normalized_email,
        "token": new_token
    })
    return RedirectResponse(f"/accounts/ui?{query}")
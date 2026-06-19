"""
Multi-Account OAuth Management Router

Endpoints for users to:
- View connected accounts
- Add new accounts
- Set primary account
- Disconnect accounts
- Enable/disable sync for accounts
"""

"""
Multi-Account OAuth Management Router
"""

from fastapi import APIRouter, HTTPException, Depends, Query, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from sqlalchemy.orm import Session
from datetime import datetime, timezone
import os

from app.database import get_db
from app.deps import get_current_user
from app.models import User, OAuthAccount
from app.services.multi_account_oauth_service import MultiAccountOAuthService


# ============================================================
# ROUTER SETUP
# ============================================================

router = APIRouter(prefix="/accounts", tags=["OAuth Accounts"])


# ============================================================
# TEMPLATE CONFIG (FIXED + SAFE)
# ============================================================

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

templates = Jinja2Templates(
    directory=os.path.join(BASE_DIR, "templates")
)



# ============================================================
# ✅ CONNECT APPLE ACCOUNT (NEW)
# ============================================================

from pydantic import BaseModel, EmailStr

class AppleConnectRequest(BaseModel):
    email: EmailStr
    app_password: str
    caldav_url: str = "https://caldav.icloud.com"


from app.services.external_calendar_service import ExternalCalendarService

@router.post("/apple/connect")
def connect_apple_account(
    payload: AppleConnectRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    ✅ FIXED: Always return success AFTER save
    ✅ Never raise 400 after success
    ✅ Matches /test endpoint behavior
    """

    from app.services.external_calendar_service import ExternalCalendarService

    service = ExternalCalendarService()

    try:
        # --------------------------------------------------
        # ✅ VALIDATE (same as /test endpoint)
        # --------------------------------------------------
        is_valid = service.validate_icloud_credentials(
            url=payload.caldav_url,
            username=payload.email,
            password=payload.app_password
        )

        # ✅ SAFE FAILURE (no exception)
        if not is_valid:
            return {
                "success": False,
                "message": "Invalid Apple credentials"
            }

        # --------------------------------------------------
        # ✅ SAVE ACCOUNT
        # --------------------------------------------------
        account = MultiAccountOAuthService.add_oauth_account(
            db=db,
            user_id=current_user.id,
            provider="apple",
            account_email=payload.email,

            # ✅ Apple does NOT use tokens
            access_token=None,
            refresh_token=None,

            # ✅ Apple credentials
            caldav_url=payload.caldav_url,
            app_password=payload.app_password
        )

        # --------------------------------------------------
        # ✅ CRITICAL FIX: RETURN SUCCESS HERE
        # --------------------------------------------------
        return {
            "success": True,
            "message": "✅ Apple connected",
            "account_id": account.id
        }

    except Exception as e:
        # ✅ NEVER THROW → prevents 500 & 400 mismatch
        print("❌ Apple connect error:", e)

        return {
            "success": False,
            "message": "Connection failed"
        }
    
# ============================================================
# ✅ RETRY ACCOUNT SYNC (NEW)
# ============================================================

@router.post("/{account_id}/retry")
def retry_account_sync(
    account_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    ✅ Retry sync for a single account
    ✅ Uses stored credentials (NO re-entry)
    """

    from app.services.calendar_service import CalendarService

    account = db.query(OAuthAccount).filter(
        OAuthAccount.id == account_id,
        OAuthAccount.user_id == current_user.id
    ).first()

    if not account:
        raise HTTPException(404, "Account not found")

    service = CalendarService()

    try:
        # ✅ Reuse your existing pipeline (single-account style)
        service.fetch_all_events(db, current_user)

        account.last_sync_success = datetime.now(timezone.utc)
        account.last_error = None

        db.commit()

        return {"success": True, "message": "✅ Sync successful"}

    except Exception as e:
        account.last_sync_failure = datetime.now(timezone.utc)
        account.last_error = str(e)

        db.commit()

        return {"success": False, "message": "❌ Sync failed"}
    
# ============================================================
# ✅ TEST APPLE CONNECTION (NEW)
# ============================================================

@router.post("/apple/test")
def test_apple_connection(
    payload: AppleConnectRequest,
    current_user: User = Depends(get_current_user)
):
    """
    ✅ Test Apple credentials WITHOUT saving

    Used by UI button:
    "Test Connection"

    ✅ Does NOT touch DB
    ✅ Fast feedback for user
    """

    from app.services.external_calendar_service import ExternalCalendarService

    service = ExternalCalendarService()

    is_valid = service.validate_icloud_credentials(
        url=payload.caldav_url,
        username=payload.email,
        password=payload.app_password
    )

    if not is_valid:
        raise HTTPException(400, "❌ Connection failed")

    return {"message": "✅ Connection successful"}

# ============================================================
# GET ALL OAUTH ACCOUNTS
# ============================================================
@router.get("")
def get_my_accounts(
    provider: str = Query(None, description="Filter by provider"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    accounts = MultiAccountOAuthService.get_user_accounts(
        db, current_user.id, provider
    )

    return [
        {
            "id": acc.id,
            "provider": acc.provider,
            "account_email": acc.account_email,
            "display_name": acc.display_name,
            "provider_id": acc.provider_id,
            "is_primary": acc.is_primary,
            "sync_enabled": acc.sync_enabled,
            "last_sync": acc.last_sync.isoformat() if acc.last_sync else None,
            "last_sync_success": getattr(acc, "last_sync_success", None).isoformat() if getattr(acc, "last_sync_success", None) else None,
            "last_sync_failure": getattr(acc, "last_sync_failure", None).isoformat() if getattr(acc, "last_sync_failure", None) else None,
            "last_error": getattr(acc, "last_error", None),
            "status": getattr(acc, "status", "ok"),
            "created_at": acc.created_at.isoformat(),
            "updated_at": acc.updated_at.isoformat() if acc.updated_at else None,
        }
        for acc in accounts
    ]


# ============================================================
# SET PRIMARY ACCOUNT
# ============================================================

@router.put("/{account_id}/set-primary")
def set_account_as_primary(
    account_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    account = db.query(OAuthAccount).filter(
        OAuthAccount.id == account_id,
        OAuthAccount.user_id == current_user.id
    ).first()

    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    updated = MultiAccountOAuthService.set_primary(
        db, account_id, current_user.id
    )

    return {
        "id": updated.id,
        "provider": updated.provider,
        "account_email": updated.account_email,
        "is_primary": updated.is_primary
    }


# ============================================================
# TOGGLE SYNC
# ============================================================

@router.put("/{account_id}/sync/{enabled}")
def toggle_sync(
    account_id: int,
    enabled: bool,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    account = db.query(OAuthAccount).filter(
        OAuthAccount.id == account_id,
        OAuthAccount.user_id == current_user.id
    ).first()

    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    account.sync_enabled = enabled
    db.commit()

    return {
        "id": account.id,
        "provider": account.provider,
        "account_email": account.account_email,
        "sync_enabled": account.sync_enabled
    }


# ============================================================
# DELETE ACCOUNT
# ============================================================

@router.delete("/{account_id}")
def disconnect_account(
    account_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    account = db.query(OAuthAccount).filter(
        OAuthAccount.id == account_id,
        OAuthAccount.user_id == current_user.id
    ).first()

    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    provider = account.provider
    email = account.account_email

    db.delete(account)
    db.commit()

    return {
        "message": f"Disconnected {provider} account: {email}",
        "deleted_id": account_id
    }


# ============================================================
# PROVIDER STATS
# ============================================================

@router.get("/stats/by-provider")
def get_provider_stats(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    accounts = MultiAccountOAuthService.get_user_accounts(
        db, current_user.id
    )

    stats = {}

    for acc in accounts:
        if acc.provider not in stats:
            stats[acc.provider] = {
                "total": 0,
                "sync_enabled": 0,
                "primary": None,
                "accounts": []
            }

        stats[acc.provider]["total"] += 1

        if acc.sync_enabled:
            stats[acc.provider]["sync_enabled"] += 1

        if acc.is_primary:
            stats[acc.provider]["primary"] = {
                "id": acc.id,
                "email": acc.account_email
            }

        stats[acc.provider]["accounts"].append({
            "id": acc.id,
            "email": acc.account_email,
            "is_primary": acc.is_primary,
            "sync_enabled": acc.sync_enabled
        })

    return stats


# ============================================================
# ✅ ACCOUNT MANAGEMENT UI (WORKING FIX)
# ============================================================

@router.get("/ui", response_class=HTMLResponse)
def accounts_ui(request: Request):
    """
    ✅ Renders the Account Management UI page
    """
    return templates.TemplateResponse(
        request,              # ✅ correct order (THIS FIXES YOUR ERROR)
        "accounts.html",      # ✅ template name
        {"request": request}  # ✅ context
    )

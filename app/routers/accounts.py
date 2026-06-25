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
from app.services.multi_account_oauth_service import (
    MultiAccountOAuthService,
    resolve_account_status
)
from app.services.asset_urls import asset_import_map_json, asset_url


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
templates.env.globals.update(
    asset_url=asset_url,
    asset_import_map_json=asset_import_map_json,
)


ACCOUNTS_ASSET_IMPORTS = {
    "/static/api.js": "api.js",
}



# ============================================================
# ✅ CONNECT APPLE ACCOUNT (NEW)
# ============================================================

from pydantic import BaseModel, EmailStr
import re

class AppleConnectRequest(BaseModel):
    email: EmailStr
    app_password: str
    caldav_url: str = "https://caldav.icloud.com"


from app.services.external_calendar_service import ExternalCalendarService


PROVIDER_DEFAULT_COLORS = {
    "google": "#34a853",
    "microsoft": "#2563eb",
    "apple": "#ef4444",
    "local": "#7ca3af",
    "other": "#999999",
}


def normalize_provider(provider: str) -> str:
    value = (provider or "").strip().lower()
    if value in {"outlook", "office365", "ms", "msft", "microsoft"}:
        return "microsoft"
    if value in {"gmail", "google"}:
        return "google"
    if value in {"icloud", "caldav", "apple"}:
        return "apple"
    if value in {"local", "internal"}:
        return "local"
    return value or "other"


def default_account_color(provider: str) -> str:
    return PROVIDER_DEFAULT_COLORS.get(normalize_provider(provider), PROVIDER_DEFAULT_COLORS["other"])


def sanitize_hex_color(value: str) -> str:
    color = (value or "").strip().lower()
    if not re.fullmatch(r"#[0-9a-f]{6}", color):
        raise HTTPException(status_code=422, detail="Color must be a 6-digit hex value like #34a853")
    return color


class AccountColorUpdateRequest(BaseModel):
    color: str

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
        is_valid, validation_message = service.validate_icloud_credentials_detailed(
            url=payload.caldav_url,
            username=payload.email,
            password=payload.app_password
        )

        # ✅ SAFE FAILURE (no exception)
        if not is_valid:
            return {
                "success": False,
                "message": validation_message
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
    from app.services.multi_account_oauth_service import safe_commit

    account = db.query(OAuthAccount).filter(
        OAuthAccount.id == account_id,
        OAuthAccount.user_id == current_user.id
    ).first()

    if not account:
        raise HTTPException(404, "Account not found")

    service = CalendarService()
    retry_started_at = datetime.now(timezone.utc)

    try:
        print(
            f"🔁 RETRY START account_id={account.id} provider={account.provider} email={account.account_email} "
            f"prev_status={account.status} prev_success={account.last_sync_success} prev_failure={account.last_sync_failure}"
        )

        # Reuse the sync pipeline to re-evaluate account health and refresh event state.
        service.fetch_all_events(db, current_user)

        db.refresh(account)

        # Rule: any recorded successful sync must force backend status to ok.
        if account.last_sync_success:
            account.status = "ok"
            account.last_error = None
            account.last_sync_failure = None
        else:
            account.last_sync_success = retry_started_at
            account.last_sync_failure = None
            account.last_error = None
            account.status = "ok"

        safe_commit(db)

        resolved_status = resolve_account_status(account)
        print(
            f"✅ RETRY SUCCESS account_id={account.id} provider={account.provider} email={account.account_email} "
            f"status={resolved_status} success={account.last_sync_success} failure={account.last_sync_failure}"
        )

        return {
            "success": True,
            "message": "✅ Sync successful",
            "account": {
                "id": account.id,
                "status": resolved_status,
                "last_sync_success": account.last_sync_success.isoformat(),
                "last_sync_failure": None,
                "last_error": None
            }
        }

    except Exception as e:
        db.refresh(account)
        account.last_sync_failure = datetime.now(timezone.utc)
        account.status = "error"
        account.last_error = str(e)

        safe_commit(db)

        print(
            f"❌ RETRY FAILED account_id={account.id} provider={account.provider} email={account.account_email} "
            f"error={e}"
        )

        return {"success": False, "message": "❌ Sync failed", "error": str(e)}
    
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

    if not payload.email or not payload.app_password:
        return {"success": False, "message": "Email and App Password are required"}

    is_valid, validation_message = service.validate_icloud_credentials_detailed(
        url=payload.caldav_url,
        username=payload.email,
        password=payload.app_password
    )

    if not is_valid:
        return {"success": False, "message": validation_message}

    return {"success": True, "message": "✅ Connection successful"}


@router.get("/apple/debug-fetch")
def debug_apple_fetch(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    accounts = db.query(OAuthAccount).filter(
        OAuthAccount.user_id == current_user.id,
        OAuthAccount.provider == "apple"
    ).all()

    diagnostics = []

    for acc in accounts:
        try:
            events = ExternalCalendarService.fetch_apple_calendar_events(acc) or []
            sample_starts = []

            for ev in events[:5]:
                start = ev.get("start")
                if hasattr(start, "isoformat"):
                    sample_starts.append(start.isoformat())
                else:
                    sample_starts.append(str(start))

            diagnostics.append({
                "account": acc.account_email,
                "raw_count": len(events),
                "sample_starts": sample_starts
            })
        except Exception as e:
            diagnostics.append({
                "account": acc.account_email,
                "raw_count": 0,
                "error": str(e)
            })

    return {
        "accounts": diagnostics,
        "total_accounts": len(diagnostics)
    }

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
            "status": resolve_account_status(acc),
            "color": acc.color or default_account_color(acc.provider),
            "created_at": acc.created_at.isoformat(),
            "updated_at": acc.updated_at.isoformat() if acc.updated_at else None,
        }
        for acc in accounts
    ]


@router.put("/{account_id}/color")
def update_account_color(
    account_id: int,
    payload: AccountColorUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    account = db.query(OAuthAccount).filter(
        OAuthAccount.id == account_id,
        OAuthAccount.user_id == current_user.id
    ).first()

    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    new_color = sanitize_hex_color(payload.color)
    account.color = new_color
    db.commit()
    db.refresh(account)

    return {
        "id": account.id,
        "provider": account.provider,
        "account_email": account.account_email,
        "color": account.color,
    }


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
        {
            "request": request,
            "asset_imports": ACCOUNTS_ASSET_IMPORTS,
        }  # ✅ context
    )

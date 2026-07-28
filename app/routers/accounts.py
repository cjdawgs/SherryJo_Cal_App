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

import logging
from app.services.sync_scheduler import scheduler, get_scheduler_health
from app.services.calendar_service import CalendarService
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from sqlalchemy.orm import Session
from datetime import datetime, timezone, timedelta
import os

from app.database import get_db
from app.deps import get_current_user
from app.models import User, OAuthAccount
from app.services.multi_account_oauth_service import (
    MultiAccountOAuthService,
    ensure_valid_token,
    resolve_account_status,
    normalize_provider,
)
from app.services.asset_urls import asset_import_map_json, asset_url
from app.utils import (
    account_summary,
    account_sync_summary,
    get_owned_or_404,
    sanitize_hex_color,
)

logger = logging.getLogger(__name__)


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

calendar_service = CalendarService()



# ============================================================
# ✅ CONNECT APPLE ACCOUNT (NEW)
# ============================================================

from pydantic import BaseModel, EmailStr

class AppleConnectRequest(BaseModel):
    email: EmailStr
    app_password: str
    caldav_url: str = "https://caldav.icloud.com"


from app.services.external_calendar_service import ExternalCalendarService


class AccountColorUpdateRequest(BaseModel):
    color: str


class AccountSyncSettingsUpdateRequest(BaseModel):
    sync_frequency_minutes: int | None = None
    sync_range_days: int | None = None
    sync_enabled: bool | None = None

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
        logger.error("❌ Apple connect error: %s", e)

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
    from app.services.graph_client import GraphClient
    from app.services.multi_account_oauth_service import safe_commit

    account = get_owned_or_404(db, OAuthAccount, account_id, current_user.id, "Account not found")

    service = CalendarService()
    retry_started_at = datetime.now(timezone.utc)
    target_key = f"{normalize_provider(account.provider)}:{(account.account_email or '').lower().strip()}"

    try:
        logger.info(
            f"🔁 RETRY START account_id={account.id} provider={account.provider} email={account.account_email} "
            f"prev_status={account.status} prev_success={account.last_sync_success} prev_failure={account.last_sync_failure}"
        )

        # Reuse sync pipeline but scope to the selected account so retry is fast and relevant.
        service.fetch_all_events(db, current_user, account_key=target_key)

        db.refresh(account)

        # Publish-capability probe for Microsoft so "Retry" reflects both read and write health.
        if normalize_provider(account.provider) == "microsoft":
            token = ensure_valid_token(db, account)
            if not token:
                account.status = "error"
                account.last_sync_failure = datetime.now(timezone.utc)
                account.last_error = "No valid token available for Microsoft publish validation."
                safe_commit(db)
                db.refresh(account)
            else:
                publish_ok, publish_msg = GraphClient().verify_calendar_write_access(token)
                if not publish_ok:
                    account.status = "error"
                    account.last_sync_failure = datetime.now(timezone.utc)
                    account.last_error = str(publish_msg or "Outlook publish permission check failed")
                    safe_commit(db)
                    db.refresh(account)

        # Keep persisted status aligned with resolver; never force OK when provider still fails.
        resolved_status = resolve_account_status(account)
        account.status = resolved_status
        safe_commit(db)
        db.refresh(account)

        summary = account_summary(account)
        token_issue = summary.get("token_issue") or {}
        has_actionable_issue = str(token_issue.get("code") or "") not in {"", "none"}

        logger.info(
            f"✅ RETRY SUCCESS account_id={account.id} provider={account.provider} email={account.account_email} "
            f"status={resolved_status} success={account.last_sync_success} failure={account.last_sync_failure}"
        )

        if has_actionable_issue:
            recommended_label = str(token_issue.get("recommended_label") or "Resolve")
            return {
                "success": False,
                "message": f"Sync checked, but this account still needs action: {token_issue.get('message')}",
                "error": token_issue.get("message") or "Account still needs attention.",
                "account": summary,
                "remediation": {
                    "code": token_issue.get("code"),
                    "recommended_action": token_issue.get("recommended_action"),
                    "recommended_label": recommended_label,
                    "steps": token_issue.get("resolution_steps") or [],
                },
            }

        return {
            "success": True,
            "message": "✅ Sync successful",
            "account": summary,
            "checked_at": retry_started_at.isoformat(),
        }

    except Exception as e:
        db.refresh(account)
        account.last_sync_failure = datetime.now(timezone.utc)
        account.status = "error"
        account.last_error = str(e)

        safe_commit(db)

        logger.error(
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

    return [account_summary(acc) for acc in accounts]


@router.get("/sync-status")
def get_sync_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    accounts = MultiAccountOAuthService.get_user_accounts(db, current_user.id)

    account_summaries = [account_sync_summary(acc) for acc in accounts]

    return {
        "scheduler": get_scheduler_health(),
        "accounts": account_summaries,
    }


@router.put("/{account_id}/sync-settings")
def update_account_sync_settings(
    account_id: int,
    payload: AccountSyncSettingsUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    account = get_owned_or_404(db, OAuthAccount, account_id, current_user.id, "Account not found")

    if payload.sync_frequency_minutes is not None:
        account.sync_frequency_minutes = max(1, min(int(payload.sync_frequency_minutes), 1440))

    if payload.sync_range_days is not None:
        account.sync_range_days = max(1, min(int(payload.sync_range_days), 3650))

    if payload.sync_enabled is not None:
        account.sync_enabled = bool(payload.sync_enabled)

    db.commit()
    db.refresh(account)

    return {
        "id": account.id,
        "provider": account.provider,
        "account_email": account.account_email,
        "sync_enabled": account.sync_enabled,
        "sync_frequency_minutes": account.sync_frequency_minutes,
        "sync_range_days": account.sync_range_days,
    }


@router.post("/{account_id}/refresh-sync")
def refresh_account_sync(
    account_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    account = get_owned_or_404(db, OAuthAccount, account_id, current_user.id, "Account not found")

    account.last_manual_refresh_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(account)

    window_days = max(1, int(getattr(account, "sync_range_days", 30) or 30))
    end_date = datetime.now(timezone.utc)
    start_date = end_date - timedelta(days=window_days)

    sync_result = calendar_service.sync_all(db, current_user, start_date=start_date, end_date=end_date)

    return {
        "success": True,
        "message": "Manual refresh started",
        "account_id": account.id,
        "last_manual_refresh_at": account.last_manual_refresh_at.isoformat(),
        "sync_result": sync_result,
    }


@router.put("/{account_id}/color")
def update_account_color(
    account_id: int,
    payload: AccountColorUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    account = get_owned_or_404(db, OAuthAccount, account_id, current_user.id, "Account not found")

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
    get_owned_or_404(db, OAuthAccount, account_id, current_user.id, "Account not found")

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
    account = get_owned_or_404(db, OAuthAccount, account_id, current_user.id, "Account not found")

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
    account = get_owned_or_404(db, OAuthAccount, account_id, current_user.id, "Account not found")

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

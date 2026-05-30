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
from datetime import datetime, UTC
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
            "is_primary": acc.is_primary,
            "sync_enabled": acc.sync_enabled,
            "last_sync": acc.last_sync.isoformat() if acc.last_sync else None,
            "created_at": acc.created_at.isoformat(),
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

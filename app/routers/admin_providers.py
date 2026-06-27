from datetime import datetime

from sqlalchemy import or_

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_admin
from app.models import OAuthAccount, User
from app.services.multi_account_oauth_service import resolve_account_status


router = APIRouter(prefix="/admin/providers", tags=["admin-providers"])


class AdminProviderCreateRequest(BaseModel):
    user_id: int
    provider: str = Field(min_length=2, max_length=50)
    provider_name: str = Field(min_length=1, max_length=120)
    contact_email: EmailStr
    status: str = Field(default="inactive", pattern=r"^(active|inactive)$")
    provider_id: str | None = Field(default=None, max_length=255)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    is_primary: bool = False


class AdminProviderUpdateRequest(BaseModel):
    provider_name: str | None = Field(default=None, min_length=1, max_length=120)
    contact_email: EmailStr | None = None
    status: str | None = Field(default=None, pattern=r"^(active|inactive)$")
    display_name: str | None = Field(default=None, max_length=255)
    provider_id: str | None = Field(default=None, max_length=255)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    is_primary: bool | None = None


class AdminProviderStatusRequest(BaseModel):
    status: str = Field(pattern=r"^(active|inactive)$")


def serialize_provider(account: OAuthAccount) -> dict:
    created_at = account.created_at
    if isinstance(created_at, datetime):
        created_at = created_at.isoformat()

    return {
        "id": account.id,
        "provider_name": account.display_name or account.provider,
        "contact_email": account.account_email,
        "status": "active" if bool(account.sync_enabled) else "inactive",
        "created_at": created_at,
        "metadata": {
            "provider": account.provider,
            "provider_id": account.provider_id,
            "display_name": account.display_name,
            "sync_enabled": account.sync_enabled,
            "is_primary": account.is_primary,
            "health_status": resolve_account_status(account),
            "last_error": account.last_error,
            "color": account.color,
            "user_id": account.user_id,
            "is_service_provider": bool(account.is_service_provider),
            "updated_at": account.updated_at.isoformat() if account.updated_at else None,
        },
    }


@router.get("")
def admin_list_providers(
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    providers = db.query(OAuthAccount).order_by(OAuthAccount.id.asc()).all()
    return [serialize_provider(provider) for provider in providers]


@router.post("")
def admin_create_provider(
    payload: AdminProviderCreateRequest,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    owner = db.query(User).filter(User.id == payload.user_id).first()
    if not owner:
        raise HTTPException(status_code=404, detail="Owner user not found")

    if payload.is_primary:
        db.query(OAuthAccount).filter(
            OAuthAccount.user_id == payload.user_id,
            OAuthAccount.provider == payload.provider.strip().lower(),
        ).update({"is_primary": False}, synchronize_session="fetch")

    provider = OAuthAccount(
        user_id=payload.user_id,
        provider=payload.provider.strip().lower(),
        account_email=payload.contact_email,
        access_token="admin-placeholder-token",
        refresh_token=None,
        display_name=payload.provider_name,
        provider_id=payload.provider_id,
        color=(payload.color or "").lower() or None,
        is_primary=bool(payload.is_primary),
        sync_enabled=payload.status == "active",
        is_service_provider=True,
        status="ok",
    )

    db.add(provider)
    db.commit()
    db.refresh(provider)

    return serialize_provider(provider)


@router.post("/cleanup-placeholders")
def admin_cleanup_provider_placeholders(
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    """
    One-time data hygiene endpoint for legacy rows created before is_service_provider existed.
    """
    rows = db.query(OAuthAccount).filter(
        OAuthAccount.access_token == "admin-placeholder-token",
        or_(
            OAuthAccount.is_service_provider == False,
            OAuthAccount.is_service_provider.is_(None),
        ),
    ).all()

    updated = 0
    for row in rows:
        row.is_service_provider = True
        updated += 1

    if updated:
        db.commit()

    return {
        "updated": updated,
        "message": "Legacy placeholder providers are now classified as service providers.",
    }


@router.get("/{provider_id}")
def admin_get_provider(
    provider_id: int,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    provider = db.query(OAuthAccount).filter(OAuthAccount.id == provider_id).first()
    if not provider:
        raise HTTPException(status_code=404, detail="Provider account not found")

    return serialize_provider(provider)


@router.put("/{provider_id}")
def admin_update_provider(
    provider_id: int,
    payload: AdminProviderUpdateRequest,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    provider = db.query(OAuthAccount).filter(OAuthAccount.id == provider_id).first()
    if not provider:
        raise HTTPException(status_code=404, detail="Provider account not found")

    if payload.provider_name is not None:
        provider.display_name = payload.provider_name

    if payload.display_name is not None:
        provider.display_name = payload.display_name

    if payload.contact_email is not None:
        provider.account_email = payload.contact_email

    if payload.provider_id is not None:
        provider.provider_id = payload.provider_id

    if payload.color is not None:
        provider.color = payload.color.lower()

    if payload.status is not None:
        provider.sync_enabled = payload.status == "active"

    if payload.is_primary is not None:
        if payload.is_primary:
            db.query(OAuthAccount).filter(
                OAuthAccount.user_id == provider.user_id,
                OAuthAccount.provider == provider.provider,
                OAuthAccount.id != provider.id,
            ).update({"is_primary": False}, synchronize_session="fetch")
            provider.is_primary = True
        else:
            provider.is_primary = False

    db.commit()
    db.refresh(provider)

    return serialize_provider(provider)


@router.delete("/{provider_id}")
def admin_delete_provider(
    provider_id: int,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    provider = db.query(OAuthAccount).filter(OAuthAccount.id == provider_id).first()
    if not provider:
        raise HTTPException(status_code=404, detail="Provider account not found")

    db.delete(provider)
    db.commit()

    return {"deleted": True, "id": provider_id}


@router.post("/{provider_id}/status")
def admin_set_provider_status(
    provider_id: int,
    payload: AdminProviderStatusRequest,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    provider = db.query(OAuthAccount).filter(OAuthAccount.id == provider_id).first()
    if not provider:
        raise HTTPException(status_code=404, detail="Provider account not found")

    next_status = payload.status.strip().lower()
    if next_status not in {"active", "inactive"}:
        raise HTTPException(status_code=422, detail="Status must be 'active' or 'inactive'")

    provider.sync_enabled = next_status == "active"

    db.commit()
    db.refresh(provider)

    return serialize_provider(provider)

from sqlalchemy import or_

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.deps import require_admin
from app.models import Event, Note, OAuthAccount, User
from app.services.multi_account_oauth_service import resolve_account_status
from app.utils import get_or_404, iso_or_none


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

class AdminBulkDeleteProvidersRequest(BaseModel):
    ids: list[int] = Field(min_length=1)
    delete_related: bool = True


def serialize_provider(account: OAuthAccount) -> dict:
    created_at = iso_or_none(account.created_at)

    owner_email = account.user.email if getattr(account, "user", None) else None

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
            "owner_email": owner_email,
            "is_service_provider": bool(account.is_service_provider),
            "updated_at": iso_or_none(account.updated_at),
        },
    }

def _provider_aliases(provider: str) -> set[str]:
    p = str(provider or "").strip().lower()
    if p in {"google", "gmail"}:
        return {"google", "gmail"}
    if p in {"microsoft", "outlook", "office365", "ms", "msft"}:
        return {"microsoft", "outlook", "office365", "ms", "msft"}
    if p in {"apple", "icloud", "caldav"}:
        return {"apple", "icloud", "caldav"}
    return {p}

def _delete_provider_related_records(db: Session, provider: OAuthAccount) -> dict:
    aliases = _provider_aliases(provider.provider)
    event_rows = db.query(Event).filter(
        Event.account_email == provider.account_email,
        Event.source.in_(list(aliases)),
    ).all()
    event_ids = [row.id for row in event_rows]

    notes_deleted = 0
    if event_ids:
        notes_deleted = db.query(Note).filter(Note.event_id.in_(event_ids)).delete(synchronize_session=False)

    events_deleted = 0
    if event_ids:
        events_deleted = db.query(Event).filter(Event.id.in_(event_ids)).delete(synchronize_session=False)

    return {
        "events_deleted": int(events_deleted),
        "notes_deleted": int(notes_deleted),
    }


@router.get("")
def admin_list_providers(
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    providers = (
        db.query(OAuthAccount)
        .options(joinedload(OAuthAccount.user))
        .order_by(OAuthAccount.id.asc())
        .all()
    )
    return [serialize_provider(provider) for provider in providers]


@router.post("")
def admin_create_provider(
    payload: AdminProviderCreateRequest,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    get_or_404(db, User, payload.user_id, "Owner user not found")

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


@router.get("/{provider_id}/related-data")
def admin_get_provider_related_data(
    provider_id: int,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    provider = get_or_404(db, OAuthAccount, provider_id, "Provider account not found")

    aliases = _provider_aliases(provider.provider)
    event_count = db.query(Event).filter(
        Event.account_email == provider.account_email,
        Event.source.in_(list(aliases)),
    ).count()
    notes_count = db.query(Note).join(Event, Note.event_id == Event.id).filter(
        Event.account_email == provider.account_email,
        Event.source.in_(list(aliases)),
    ).count()

    return {
        "provider": serialize_provider(provider),
        "related": {
            "events": int(event_count),
            "notes": int(notes_count),
        },
    }


@router.post("/{provider_id}/purge-related")
def admin_purge_provider_related_data(
    provider_id: int,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    provider = get_or_404(db, OAuthAccount, provider_id, "Provider account not found")

    deleted = _delete_provider_related_records(db, provider)
    db.commit()

    return {
        "purged": True,
        "provider_id": provider_id,
        "deleted": deleted,
    }


@router.get("/{provider_id}")
def admin_get_provider(
    provider_id: int,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    provider = get_or_404(db, OAuthAccount, provider_id, "Provider account not found")

    return serialize_provider(provider)


@router.put("/{provider_id}")
def admin_update_provider(
    provider_id: int,
    payload: AdminProviderUpdateRequest,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    provider = get_or_404(db, OAuthAccount, provider_id, "Provider account not found")

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
    provider = get_or_404(db, OAuthAccount, provider_id, "Provider account not found")

    db.delete(provider)
    db.commit()

    return {"deleted": True, "id": provider_id}

@router.post("/bulk-delete")
def admin_bulk_delete_providers(
    payload: AdminBulkDeleteProvidersRequest,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    target_ids = sorted({int(v) for v in payload.ids if int(v) > 0})
    if not target_ids:
        raise HTTPException(status_code=422, detail="No valid provider ids provided")

    rows = db.query(OAuthAccount).filter(OAuthAccount.id.in_(target_ids)).all()
    rows_by_id = {row.id: row for row in rows}

    deleted_providers = 0
    skipped = []
    aggregate = {
        "events_deleted": 0,
        "notes_deleted": 0,
    }

    for provider_id in target_ids:
        provider = rows_by_id.get(provider_id)
        if not provider:
            skipped.append({"id": provider_id, "reason": "not_found"})
            continue

        if payload.delete_related:
            deleted = _delete_provider_related_records(db, provider)
            for key, value in deleted.items():
                aggregate[key] += int(value)

        db.delete(provider)
        deleted_providers += 1

    db.commit()

    return {
        "deleted_providers": deleted_providers,
        "requested": len(target_ids),
        "skipped": skipped,
        "deleted_related": aggregate,
    }


@router.post("/{provider_id}/status")
def admin_set_provider_status(
    provider_id: int,
    payload: AdminProviderStatusRequest,
    db: Session = Depends(get_db),
    admin_user: User = Depends(require_admin),
):
    provider = get_or_404(db, OAuthAccount, provider_id, "Provider account not found")

    next_status = payload.status.strip().lower()
    if next_status not in {"active", "inactive"}:
        raise HTTPException(status_code=422, detail="Status must be 'active' or 'inactive'")

    provider.sync_enabled = next_status == "active"

    db.commit()
    db.refresh(provider)

    return serialize_provider(provider)

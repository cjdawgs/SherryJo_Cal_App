"""Shared API serializers."""

from app.models import OAuthAccount
from app.utils.colors import default_account_color
from app.utils.datetimes import iso_or_none


def account_sync_summary(account: OAuthAccount) -> dict:
    """Sync-related fields shared by the account list and sync-status payloads."""
    from app.services.multi_account_oauth_service import resolve_account_status

    return {
        "id": account.id,
        "provider": account.provider,
        "account_email": account.account_email,
        "sync_enabled": account.sync_enabled,
        "status": resolve_account_status(account),
        "last_sync": iso_or_none(account.last_sync),
        "last_sync_success": iso_or_none(getattr(account, "last_sync_success", None)),
        "last_sync_failure": iso_or_none(getattr(account, "last_sync_failure", None)),
        "last_error": getattr(account, "last_error", None),
        "sync_frequency_minutes": getattr(account, "sync_frequency_minutes", 5) or 5,
        "sync_range_days": getattr(account, "sync_range_days", 30) or 30,
        "last_manual_refresh_at": iso_or_none(
            getattr(account, "last_manual_refresh_at", None)
        ),
    }


def account_summary(account: OAuthAccount) -> dict:
    """Full account payload returned by the account list endpoint."""
    return {
        **account_sync_summary(account),
        "display_name": account.display_name,
        "provider_id": account.provider_id,
        "is_primary": account.is_primary,
        "color": account.color or default_account_color(account.provider),
        "created_at": iso_or_none(account.created_at),
        "updated_at": iso_or_none(account.updated_at),
    }

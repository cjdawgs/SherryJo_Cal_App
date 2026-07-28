"""Shared API serializers."""

from typing import TYPE_CHECKING

from app.utils.colors import default_account_color
from app.utils.crypto import TokenEncryptionError
from app.utils.datetimes import iso_or_none

if TYPE_CHECKING:  # pragma: no cover - avoids an import cycle with app.models
    from app.models import OAuthAccount


def account_sync_summary(account: "OAuthAccount") -> dict:
    """Sync-related fields shared by the account list and sync-status payloads."""
    from app.services.multi_account_oauth_service import resolve_account_status

    decrypt_error = False
    credential_warning = None
    token_column_value = getattr(account, "access_token_encrypted", "") or ""
    encrypted_at_rest = str(token_column_value).startswith("v1:")

    try:
        # Trigger decryption once so we can provide a structured warning field
        # in the API payload instead of failing the whole endpoint.
        _ = (getattr(account, "access_token", "") or "").strip()
    except TokenEncryptionError as exc:
        decrypt_error = True
        credential_warning = {
            "code": "token_decrypt_failed",
            "message": str(exc),
        }

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
        "credential_state": {
            "encrypted_at_rest": encrypted_at_rest,
            "decrypt_error": decrypt_error,
            "warning": credential_warning,
        },
    }


def account_summary(account: "OAuthAccount") -> dict:
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

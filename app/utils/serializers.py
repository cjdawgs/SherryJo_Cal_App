"""Shared API serializers."""

from datetime import datetime, timezone

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

    token_issue = _classify_token_issue(account, decrypt_error, credential_warning)

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
        "token_issue": token_issue,
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


def _classify_token_issue(account: "OAuthAccount", decrypt_error: bool, credential_warning: dict | None) -> dict:
    """Return a user-facing token issue classification and remediation guidance."""
    if decrypt_error:
        warning_message = str((credential_warning or {}).get("message") or "").lower()
        if "not configured" in warning_message:
            code = "app_key_missing"
            message = "App encryption key is not configured, so saved credentials cannot be read in this environment."
        elif "could not be decrypted" in warning_message:
            code = "app_key_mismatch"
            message = "App encryption key does not match stored credentials in this environment."
        else:
            code = "app_key_error"
            message = "Saved credentials cannot be read because of an app encryption-key issue."

        return {
            "code": code,
            "message": message,
            "requires_admin": True,
            "user_remediable": False,
            "recommended_action": "open_accounts",
            "recommended_label": "Open Accounts",
        }

    token_value = str(getattr(account, "access_token", "") or "").strip()
    refresh_value = str(getattr(account, "refresh_token", "") or "").strip()

    if token_value == "__REAUTH_REQUIRED__":
        return {
            "code": "token_expired_or_invalid",
            "message": "Connection expired or token is invalid. Reconnect this account.",
            "requires_admin": False,
            "user_remediable": True,
            "recommended_action": "reconnect",
            "recommended_label": "Reconnect",
        }

    if not token_value and not refresh_value:
        return {
            "code": "token_never_connected",
            "message": "No credential has been saved for this account yet. Connect this account to create one.",
            "requires_admin": False,
            "user_remediable": True,
            "recommended_action": "open_accounts",
            "recommended_label": "Open Accounts",
        }

    expires_at = getattr(account, "token_expires_at", None)
    if expires_at is not None and getattr(expires_at, "tzinfo", None) is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at and expires_at < datetime.now(timezone.utc):
        return {
            "code": "token_expired_or_invalid",
            "message": "Token is expired. Reconnect this account.",
            "requires_admin": False,
            "user_remediable": True,
            "recommended_action": "reconnect",
            "recommended_label": "Reconnect",
        }

    last_error = str(getattr(account, "last_error", "") or "").strip().lower()
    if getattr(account, "status", "ok") == "error":
        if any(flag in last_error for flag in ("expired", "invalid", "revoked", "invalid_grant", "reauth", "no valid token")):
            return {
                "code": "token_expired_or_invalid",
                "message": "Connection expired or token is invalid. Reconnect this account.",
                "requires_admin": False,
                "user_remediable": True,
                "recommended_action": "reconnect",
                "recommended_label": "Reconnect",
            }
        return {
            "code": "sync_error",
            "message": "Sync failed for this account. Retry sync from Account Manager.",
            "requires_admin": False,
            "user_remediable": True,
            "recommended_action": "retry_sync",
            "recommended_label": "Retry Sync",
        }

    return {
        "code": "none",
        "message": "",
        "requires_admin": False,
        "user_remediable": True,
        "recommended_action": "none",
        "recommended_label": "",
    }

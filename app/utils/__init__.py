"""Shared helpers used across routers and services."""

from app.utils.colors import (
    PROVIDER_DEFAULT_COLORS,
    default_account_color,
    normalize_hex_color,
    sanitize_hex_color,
)
from app.utils.crypto import encryption_enabled, mask, seal, unseal
from app.utils.datetimes import ensure_utc, iso_or_none, parse_iso_datetime
from app.utils.db import get_or_404, get_owned_or_404, safe_rollback
from app.utils.serializers import account_summary, account_sync_summary

__all__ = [
    "PROVIDER_DEFAULT_COLORS",
    "account_summary",
    "account_sync_summary",
    "default_account_color",
    "encryption_enabled",
    "ensure_utc",
    "get_or_404",
    "get_owned_or_404",
    "iso_or_none",
    "mask",
    "normalize_hex_color",
    "parse_iso_datetime",
    "safe_rollback",
    "sanitize_hex_color",
    "seal",
    "unseal",
]

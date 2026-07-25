"""Color helpers shared by account and calendar endpoints."""

import re

from fastapi import HTTPException

DEFAULT_EVENT_COLOR = "#4F8EF7"

PROVIDER_DEFAULT_COLORS = {
    "google": "#34a853",
    "microsoft": "#2563eb",
    "apple": "#ef4444",
    "local": "#7ca3af",
    "other": "#999999",
}

_HEX_COLOR_PATTERN = re.compile(r"#[0-9a-f]{6}")


def default_account_color(provider: str) -> str:
    """Return the brand color configured for a provider."""
    from app.services.multi_account_oauth_service import normalize_provider

    return PROVIDER_DEFAULT_COLORS.get(
        normalize_provider(provider), PROVIDER_DEFAULT_COLORS["other"]
    )


def normalize_hex_color(value, fallback: str = DEFAULT_EVENT_COLOR) -> str:
    """Return a valid ``#rrggbb`` color, falling back when the input is invalid."""
    color = str(value or "").strip()
    if _HEX_COLOR_PATTERN.fullmatch(color.lower()):
        return color
    return fallback


def sanitize_hex_color(value: str) -> str:
    """Return a lowercased ``#rrggbb`` color or raise a 422 for invalid input."""
    color = (value or "").strip().lower()
    if not _HEX_COLOR_PATTERN.fullmatch(color):
        raise HTTPException(
            status_code=422, detail="Color must be a 6-digit hex value like #34a853"
        )
    return color

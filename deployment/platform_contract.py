"""Validate configuration required by each production deployment target."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
from urllib.parse import urlsplit


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]

RENDER_REQUIRED = (
    "ADMIN_SETUP_CODE",
    "BASE_URL",
    "DATABASE_URL",
    "DB_TYPE",
    "DISABLE_SQLITE_FALLBACK",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
    "JWT_ALGORITHM",
    "JWT_SECRET_KEY",
    "MS_CLIENT_ID",
    "MS_CLIENT_SECRET",
    "MS_REDIRECT_URI",
    "MS_TENANT_ID",
    "REQUIRE_DB_KIND",
    "TOKEN_ENCRYPTION_KEY",
)

CLOUDFLARE_EDGE_REQUIRED = ("ORIGIN_BASE_URL",)

REQUIRED_FILES = (
    ".github/workflows/tests.yml",
    "render.yaml",
    "wrangler.toml",
    "platform/cloudflare/src/worker.js",
)


def _is_https_url(value: str) -> bool:
    parsed = urlsplit(value)
    return parsed.scheme == "https" and bool(parsed.netloc)


def validate_repository() -> list[str]:
    return [f"Missing required file: {path}" for path in REQUIRED_FILES if not (REPOSITORY_ROOT / path).is_file()]


def validate_render(environment: dict[str, str]) -> list[str]:
    errors = [f"Missing Render variable: {name}" for name in RENDER_REQUIRED if not environment.get(name, "").strip()]

    for name in ("BASE_URL", "GOOGLE_REDIRECT_URI", "MS_REDIRECT_URI"):
        value = environment.get(name, "").strip()
        if value and not _is_https_url(value):
            errors.append(f"{name} must be an absolute HTTPS URL")

    database_url = environment.get("DATABASE_URL", "").strip().lower()
    if database_url and not database_url.startswith(("postgres://", "postgresql://", "postgresql+psycopg2://")):
        errors.append("DATABASE_URL must use PostgreSQL in production")
    if environment.get("DB_TYPE", "").strip().lower() != "postgres":
        errors.append("DB_TYPE must be postgres in production")
    if environment.get("DISABLE_SQLITE_FALLBACK", "").strip().lower() not in {"1", "true", "yes", "on"}:
        errors.append("DISABLE_SQLITE_FALLBACK must be enabled in production")
    if environment.get("REQUIRE_DB_KIND", "").strip().lower() != "postgres":
        errors.append("REQUIRE_DB_KIND must be postgres in production")
    if environment.get("JWT_ALGORITHM", "").strip().upper() != "HS256":
        errors.append("JWT_ALGORITHM must remain HS256 until a coordinated token migration")

    return errors


def validate_cloudflare_edge(environment: dict[str, str]) -> list[str]:
    errors = [
        f"Missing Cloudflare variable: {name}"
        for name in CLOUDFLARE_EDGE_REQUIRED
        if not environment.get(name, "").strip()
    ]
    origin = environment.get("ORIGIN_BASE_URL", "").strip()
    if origin and not _is_https_url(origin):
        errors.append("ORIGIN_BASE_URL must be an absolute HTTPS URL")
    return errors


def validate(target: str, environment: dict[str, str] | None = None) -> list[str]:
    environment = environment or dict(os.environ)
    errors = validate_repository()
    if target in {"render", "all"}:
        errors.extend(validate_render(environment))
    if target in {"cloudflare-edge", "all"}:
        errors.extend(validate_cloudflare_edge(environment))
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=("repository", "render", "cloudflare-edge", "all"), default="repository")
    args = parser.parse_args()

    errors = validate(args.target)
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1

    print(f"Deployment contract valid for target: {args.target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
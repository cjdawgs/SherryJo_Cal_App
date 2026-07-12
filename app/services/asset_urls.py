from __future__ import annotations

import hashlib
import json
from pathlib import Path


STATIC_DIR = Path(__file__).resolve().parents[1] / "static"

# Module-level hash cache — populated on first access, never expires within a
# process lifetime. Eliminates repeated file reads for fingerprinted URLs.
_hash_cache: dict[str, str] = {}


def _resolve_asset_path(asset_name: str) -> Path:
    relative_name = str(asset_name or "").lstrip("/")
    if relative_name.startswith("static/"):
        relative_name = relative_name[len("static/"):]
    return STATIC_DIR / relative_name


def asset_hash(asset_name: str) -> str:
    relative_name = str(asset_name or "").lstrip("/")
    if relative_name.startswith("static/"):
        relative_name = relative_name[len("static/"):]
    asset_path = STATIC_DIR / relative_name
    # Cache key = full path + mtime so file changes and STATIC_DIR patches both bust the cache
    mtime_ns = asset_path.stat().st_mtime_ns
    cache_key = f"{asset_path}|{mtime_ns}"
    if cache_key not in _hash_cache:
        content = asset_path.read_bytes()
        _hash_cache[cache_key] = hashlib.sha256(content).hexdigest()[:12]
    return _hash_cache[cache_key]


def asset_url(asset_name: str) -> str:
    relative_name = str(asset_name or "").lstrip("/")
    if relative_name.startswith("static/"):
        relative_name = relative_name[len("static/"):]
    return f"/static/{relative_name}?v={asset_hash(relative_name)}"


def asset_import_map_json(imports: dict[str, str]) -> str:
    resolved = {
        specifier: asset_url(asset_name)
        for specifier, asset_name in (imports or {}).items()
    }
    return json.dumps({"imports": resolved}, separators=(",", ":"))
from __future__ import annotations

import hashlib
import json
from pathlib import Path


STATIC_DIR = Path(__file__).resolve().parents[1] / "static"


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
    content = asset_path.read_bytes()
    return hashlib.sha256(content).hexdigest()[:12]


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
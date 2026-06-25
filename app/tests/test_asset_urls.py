from pathlib import Path

from app.services import asset_urls


def test_asset_url_hash_changes_when_file_changes(tmp_path, monkeypatch):
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    asset_path = static_dir / "sample.js"
    asset_path.write_text("console.log('one');", encoding="utf-8")

    monkeypatch.setattr(asset_urls, "STATIC_DIR", static_dir)

    first_url = asset_urls.asset_url("sample.js")
    asset_path.write_text("console.log('two');", encoding="utf-8")
    second_url = asset_urls.asset_url("sample.js")

    assert first_url != second_url
    assert first_url.startswith("/static/sample.js?v=")
    assert second_url.startswith("/static/sample.js?v=")


def test_asset_import_map_json_uses_fingerprinted_urls(tmp_path, monkeypatch):
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    (static_dir / "core.js").write_text("export const value = 1;", encoding="utf-8")

    monkeypatch.setattr(asset_urls, "STATIC_DIR", static_dir)

    import_map = asset_urls.asset_import_map_json({"/static/core.js": "core.js"})

    assert "/static/core.js?v=" in import_map
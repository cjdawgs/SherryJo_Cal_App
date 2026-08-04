from pathlib import Path


def test_dedup_off_forces_account_identity_color_in_every_desktop_view():
    path = Path(__file__).resolve().parents[2] / "app" / "static" / "calendar.ui.js"
    text = path.read_text(encoding="utf-8")

    assert 'typeof window.isDedupEnabled === "function" && !window.isDedupEnabled()' in text
    assert 'return normalizeColorValue(accountColor, "#4285f4");' in text


def test_tv_requests_account_expanded_rows_for_client_side_dedup_toggle():
    root = Path(__file__).resolve().parents[2]
    path = root / "app" / "routers" / "tv.py"
    text = path.read_text(encoding="utf-8")
    dashboard = (root / "app" / "static" / "tv_dashboard.js").read_text(encoding="utf-8")

    assert "dedup: bool = True" in text
    assert "dedup_enabled=dedup" in text
    assert "params.set('dedup', 'false')" in dashboard
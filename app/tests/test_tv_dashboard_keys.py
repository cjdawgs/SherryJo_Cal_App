from pathlib import Path


def _tv_js_text() -> str:
    path = Path(__file__).resolve().parents[2] / "app" / "static" / "tv_dashboard.js"
    return path.read_text(encoding="utf-8")


def test_tv_dashboard_has_single_global_key_listener_set():
    text = _tv_js_text()
    # Use only window listeners to avoid duplicate key handling.
    assert text.count("window.addEventListener('keydown', onKeyDown)") == 1
    assert text.count("window.addEventListener('keyup', onKeyUp)") == 1
    assert "document.addEventListener('keydown', onKeyDown)" not in text
    assert "document.addEventListener('keyup', onKeyUp)" not in text


def test_tv_dashboard_normalize_key_supports_remote_and_keyboard_sets():
    text = _tv_js_text()
    required_tokens = [
        "AudioVolumeMute",
        "AudioVolumeUp",
        "AudioVolumeDown",
        "NumpadAdd",
        "NumpadSubtract",
        "PageUp",
        "PageDown",
        "kc === 19",
        "kc === 20",
        "kc === 21",
        "kc === 22",
        "kc === 23",
    ]
    for token in required_tokens:
        assert token in text


def test_tv_dashboard_prevents_overlapping_events_requests():
    text = _tv_js_text()
    assert "eventsRequestInFlight" in text
    assert "eventsRefreshQueued" in text
    assert "if (state.eventsRequestInFlight)" in text


def test_tv_dashboard_exposes_month_popout_and_sidebar_actions():
    text = _tv_js_text()
    required_tokens = [
        "monthDetailOpen",
        "tv-user-email",
        "Undo",
        "Redo",
        "Manage Accounts",
        "Admin Dashboard",
        "month-popout",
    ]
    for token in required_tokens:
        assert token in text


def test_tv_dashboard_exposes_account_chip_filtering_and_sticky_icons():
    text = _tv_js_text()
    required_tokens = [
        "selectedAccountKeys",
        "data-tv-click=\"account-chip\"",
        "clickAccountChip",
        "toggleMultiAccountFilter",
        "hasSticky",
        "tv-sticky-indicator",
    ]
    for token in required_tokens:
        assert token in text


def test_tv_dashboard_auth_fetch_handles_network_exceptions():
    text = _tv_js_text()
    assert "async function authFetch" in text
    assert "try {" in text
    assert "catch (err)" in text
    assert "Network issue:" in text


def test_tv_dashboard_recovers_refresh_after_fireos_suspension():
    text = _tv_js_text()
    assert "const POLL_MS = 60000" in text
    assert "deltaMs >= POLL_MS" in text
    assert "window.addEventListener('online'" in text
    assert "state.lastEventsFetchAt = Date.now()" in text


def test_tv_dashboard_remote_up_down_zoom_and_center_reset():
    text = _tv_js_text()
    assert "adjustZoom(key === 'ArrowUp' ? ZOOM_STEP : -ZOOM_STEP)" in text
    assert "function applyZoom()" in text
    assert "function resetZoom()" in text
    assert "if (count === 1 && resetZoom()) return" in text
    assert "center resets" in text

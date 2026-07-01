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


def test_tv_dashboard_auth_fetch_handles_network_exceptions():
    text = _tv_js_text()
    assert "async function authFetch" in text
    assert "try {" in text
    assert "catch (err)" in text
    assert "Network issue:" in text

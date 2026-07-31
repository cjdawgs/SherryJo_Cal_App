from pathlib import Path


def _tv_js_text() -> str:
    path = Path(__file__).resolve().parents[2] / "app" / "static" / "tv_dashboard.js"
    return path.read_text(encoding="utf-8")


def _tv_zoom_engine_text() -> str:
    path = Path(__file__).resolve().parents[2] / "app" / "static" / "tv_zoom_engine.js"
    return path.read_text(encoding="utf-8")


def _tv_template_text(name: str) -> str:
    path = Path(__file__).resolve().parents[2] / "app" / "templates" / name
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


def test_tv_dashboard_normalizes_pairing_codes_with_dash_separator():
    text = _tv_js_text()
    assert "function normalizePairingCode(raw)" in text
    assert "replace(/[^A-Za-z0-9]/g, '')" in text
    assert "return `${compact.slice(0, 4)}-${compact.slice(4)}`;" in text
    assert "XXXX-XXXX" in text


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
        "View 3-Day",
        "data-control=\"view-three-day\"",
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
        "extractExternalAccountIdentity",
        "external_ids",
        "sticky-note-mini.svg",
    ]
    for token in required_tokens:
        assert token in text


def test_tv_dashboard_prefers_external_identity_when_local_identity_is_placeholder():
    text = _tv_js_text()
    required_tokens = [
        "function shouldPreferExternalIdentity(source, account)",
        "normalizedAccount === 'local'",
        "externalIdentity && shouldPreferExternalIdentity(resolvedSource, account)",
    ]
    for token in required_tokens:
        assert token in text


def test_tv_dashboard_color_rendering_paths_cover_month_and_shared_views():
    text = _tv_js_text()
    required_tokens = [
        "function renderDayCard(day, selected, contextDay",
        "function renderMonthView()",
        "function renderMonthCell(day, idx)",
        "function renderEventSummaryCard(ev, bucket, index",
        "function renderRightRail(selectedDateKey, weekDateKeys, extraClass",
        "resolveEventColor(ev)",
        "resolveEventColor(item.event)",
        "resolveEventColor(row.ev)",
        "softColor(eventColor, 0.2)",
        "softColor(eventColor, 0.52)",
    ]
    for token in required_tokens:
        assert token in text


def test_tv_dashboard_exposes_visible_zoom_settings_panel():
    text = _tv_js_text()
    required_tokens = [
        "TV Settings",
        "Current Zoom",
        "Home Zoom",
        "Zoom In",
        "Zoom Out",
        "Save Current As Home",
        "Restore Home Zoom",
        "Reset to 100%",
        "openSettingsPanel()",
    ]
    for token in required_tokens:
        assert token in text


def test_quick_launch_guide_documents_firetv_remote_map():
    path = Path(__file__).resolve().parents[2] / "docs" / "quick_launch_firetv.md"
    text = path.read_text(encoding="utf-8")
    required_tokens = [
        "FireTV Quick Launch Guide",
        "Long press 600ms",
        "Zoom In",
        "Zoom Out",
        "F / Home",
        "Visible Settings Panel",
        "Mode NAV • Zoom 100%",
        "FF or Channel Up",
        "REW or Channel Down",
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
    engine_text = _tv_zoom_engine_text()
    required_tokens = [
        "createTvZoomEngine",
        "handleZoomHoldKeyDown(key)",
        "handleZoomHoldKeyUp(key)",
        "zoomIn()",
        "zoomOut()",
        "saveCurrentZoomAsDefault()",
        "applyHomeZoomPreference()",
        "function applyZoom()",
        "function resetZoom()",
    ]
    for token in required_tokens:
        assert token in text
    assert "tv_zoom_level" in engine_text
    assert "tv_default_zoom_level" in engine_text
    assert "SUPPORTED_ZOOM_LEVELS" in engine_text
    assert "inputMode" in text
    assert "function setInputMode" in text
    assert "'locked'" in text
    assert "Mode ${modeLabel}" in text
    assert "Zoom ${state.zoomLevel}%" in text
    assert "if (count === 1 && resetZoom()) return" in text


def test_tv_dashboard_persists_remote_capabilities_and_dynamic_help():
    text = _tv_js_text()
    required_tokens = [
        "tv_remote_capabilities_v1",
        "buildDynamicRemoteHelpText",
        "renderRemoteCapabilitySummary",
        "renderDynamicQuickLaunchSummary",
        "markRemoteCapability",
        "Mode locked • Triple SELECT unlock",
    ]
    for token in required_tokens:
        assert token in text


def test_tv_dashboard_has_center_lower_remote_action_echo():
    text = _tv_js_text()
    required_tokens = [
        "tv-remote-action-echo",
        "showRemoteAction",
        "Long Select Create",
        "Nav ${key.replace('Arrow', '')}",
    ]
    for token in required_tokens:
        assert token in text


def test_tv_dashboard_zoom_css_variable_is_centralized():
    tv_template = _tv_template_text("tv.html")
    kiosk_template = _tv_template_text("tv_kiosk.html")
    engine_text = _tv_zoom_engine_text()
    assert "--tv-scale" in tv_template
    assert "--tv-scale" in kiosk_template
    assert "--tv-scale" in engine_text
    dashboard_text = _tv_js_text()
    assert "style.zoom" not in dashboard_text


def test_tv_dashboard_clears_hold_state_on_lifecycle_interruptions():
    text = _tv_js_text()
    required_tokens = [
        "function clearRemoteHoldState()",
        "function clearZoomHoldState()",
        "function clearSelectLongPressState()",
        "window.addEventListener('blur', () => {",
        "window.addEventListener('pagehide', (e) => {",
        "document.addEventListener('freeze', () => {",
        "if (document.hidden) {",
    ]
    for token in required_tokens:
        assert token in text
    assert text.count("clearRemoteHoldState();") >= 4

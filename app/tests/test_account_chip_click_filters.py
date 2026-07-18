from pathlib import Path
import re


JS_PATH = Path(__file__).resolve().parents[2] / "app" / "static" / "calendar.js"
FC_JS_PATH = Path(__file__).resolve().parents[2] / "app" / "static" / "calendar.fullcalendar.js"


def _js_text() -> str:
    return JS_PATH.read_text(encoding="utf-8")


def _fc_js_text() -> str:
    return FC_JS_PATH.read_text(encoding="utf-8")


def test_single_click_sets_exclusive_filter_and_refreshes_views():
    text = _js_text()

    assert "row.onclick = (e) => {" in text
    assert "const isMultiSelect = isChipMultiSelectEvent(e);" in text
    assert "if (!isMultiSelect) {" in text
    assert "activeAccountFilters.clear();" in text
    assert "activeAccountFilters.add(key);" in text
    assert "chipClickTimer = setTimeout(() => {" in text
    assert "if (e.detail > 1) {" in text
    assert "if (Date.now() < suppressChipClickUntil) {" in text
    assert "applyClientSideFilters();" in text
    assert "setTimeout(() => {" in text
    assert "window.updateDayDetails?.();" in text
    assert "window.updateWeekView?.();" in text


def test_ctrl_or_cmd_click_adds_or_removes_chip_filter():
    text = _js_text()

    assert "function isChipMultiSelectEvent(e)" in text
    assert "e.ctrlKey || e.metaKey" in text
    assert "e.getModifierState(\"Control\")" in text
    assert "e.getModifierState(\"Meta\")" in text
    assert "chipMultiSelectModifierDown" in text

    assert "if (activeAccountFilters.has(key)) {" in text
    assert "if (activeAccountFilters.size > 1) {" in text
    assert "activeAccountFilters.delete(key);" in text
    assert "} else {" in text
    assert "activeAccountFilters.add(key);" in text


def test_double_click_resets_all_accounts_and_recounts_badges():
    text = _js_text()

    assert "let chipClickTimer = null;" in text
    assert "row.ondblclick = (e) => {" in text
    assert "e.preventDefault();" in text
    assert "e.stopPropagation();" in text
    assert "if (chipClickTimer) {" in text
    assert "clearTimeout(chipClickTimer);" in text
    assert "suppressChipClickUntil = Date.now() + 350;" in text
    assert "document.querySelectorAll(\"#accounts .chip[data-key]\")" in text
    assert "activeAccountFilters = new Set([...allAccountKeys, ...domKeys]);" in text
    assert "updateChipSelectionUI();" in text
    assert "applyClientSideFilters();" in text
    assert "updateChipEventCounts();" in text


def test_main_calendar_day_week_month_views_use_filtered_source():
    cal_text = _fc_js_text()

    # Main FullCalendar supports Month/Week/Day views.
    assert 'dayGridMonth: "Month"' in cal_text
    assert 'timeGridWeek: "Week"' in cal_text
    assert 'timeGridDay: "Day"' in cal_text

    # Single unified events source must consume account-filtered results.
    assert "sourceEvents = typeof window.getFilteredEvents === \"function\"" in cal_text
    assert "window.getFilteredEvents({ start: rangeStart, end: rangeEnd })" in cal_text


def test_filtered_events_engine_uses_account_key_for_all_main_views():
    text = _js_text()

    assert "function getFilteredEvents({ start, end })" in text
    assert "const key = getCalendarEventAccountKey(ev);" in text
    assert "if (activeAccountFilters.size && !activeAccountFilters.has(key)) {" in text
    assert "return dedupeEventsForDisplay(events);" in text


def test_dedup_on_collapses_display_duplicates():
    text = _js_text()

    assert "function getDisplayDedupKey(ev)" in text
    assert "function dedupeEventsForDisplay(events)" in text
    assert "if (!isDedupEnabled()) return events;" in text
    assert "return `${title}|${startMinute.toISOString().slice(0, 16)}`;" in text


def test_apply_client_side_filters_uses_live_calendar_instance():
    text = _js_text()

    assert "function applyClientSideFilters()" in text
    assert "const cal = getCalendar();" in text
    assert "if (!cal) return;" in text
    assert "cal.refetchEvents();" in text
    assert "if (!calendar) return;" not in text


def test_day_sidebar_honors_active_account_filters():
    text = _js_text()

    day_fn = re.search(
        r"function updateDayDetails\(\)\s*\{(?P<body>.*?)\n\}\n\nwindow\.updateDayDetails",
        text,
        flags=re.DOTALL,
    )
    assert day_fn, "updateDayDetails function missing"
    body = day_fn.group("body")

    assert "const events = dedupeEventsForDisplay((window.sessionEventCache || []).filter(ev => {" in body
    assert "const key = getCalendarEventAccountKey(ev);" in body
    assert "if (activeAccountFilters.size && !activeAccountFilters.has(key)) {" in body


def test_week_sidebar_honors_active_account_filters():
    text = _js_text()

    week_fn = re.search(
        r"function updateWeekView\(\)\s*\{(?P<body>.*?)\n\}\nwindow\.updateWeekView",
        text,
        flags=re.DOTALL,
    )
    assert week_fn, "updateWeekView function missing"
    body = week_fn.group("body")

    assert "const events = dedupeEventsForDisplay(window.sessionEventCache.filter(ev => {" in body
    assert "const key = getCalendarEventAccountKey(ev);" in body
    assert "if (activeAccountFilters.size && !activeAccountFilters.has(key)) {" in body

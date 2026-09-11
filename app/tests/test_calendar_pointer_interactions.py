from pathlib import Path


CALENDAR_FULLCALENDAR_JS = Path(__file__).resolve().parents[2] / "app" / "static" / "calendar.fullcalendar.js"


def test_date_double_click_opens_create_modal_without_single_click_selection():
    source = CALENDAR_FULLCALENDAR_JS.read_text(encoding="utf-8")

    assert "window._dateClickTimer && window._lastClickedDate === dateStr" in source
    assert "clearTimeout(window._dateClickTimer);" in source
    assert "window.openCreateModal(info.date);" in source
    assert "window._dateClickTimer = setTimeout(() => {" in source
    assert "setSelectedDateFromInteraction(info.date);" in source
    assert "setSelectedEvent(null);" in source


def test_event_double_click_opens_editor_and_single_click_selects_event():
    source = CALENDAR_FULLCALENDAR_JS.read_text(encoding="utf-8")

    assert "window._eventClickTimer && window._lastClickedEventId === id" in source
    assert "clearTimeout(window._eventClickTimer);" in source
    assert "window.openCreateModal?.(null, info.event);" in source
    assert "window._eventClickTimer = setTimeout(() => {" in source
    assert "setSelectedEvent(id);" in source


def test_event_and_empty_date_right_clicks_open_their_context_menus():
    source = CALENDAR_FULLCALENDAR_JS.read_text(encoding="utf-8")

    assert 'info.el.addEventListener("contextmenu", (e) => {' in source
    assert "openContextMenu(e.clientX, e.clientY, info.event);" in source
    assert 'calEl.addEventListener("contextmenu", (e) => {' in source
    assert "openDateContextMenu(e.clientX, e.clientY, dateStr);" in source
    assert "e.preventDefault();" in source
    assert "e.stopPropagation();" in source
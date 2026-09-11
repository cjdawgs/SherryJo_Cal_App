from pathlib import Path


CALENDAR_JS = Path(__file__).resolve().parents[2] / "app" / "static" / "calendar.js"


def test_create_action_menu_wires_visible_event_and_import_actions():
    source = CALENDAR_JS.read_text(encoding="utf-8")

    assert 'const createNewEventBtn = document.getElementById("createNewEventBtn");' in source
    assert 'const importEventsMenuBtn = document.getElementById("importEventsMenuBtn");' in source
    assert "createNewEventBtn?.addEventListener(\"click\"" in source
    assert "importEventsMenuBtn?.addEventListener(\"click\"" in source
    assert "openCreateModal();" in source
    assert "importFileInput?.click();" in source
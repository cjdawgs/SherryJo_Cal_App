from __future__ import annotations

import argparse
import json
from urllib.parse import urlparse

from playwright.sync_api import Route, sync_playwright

DEFAULT_BASE = "http://127.0.0.1:8000"


def _mock_api(route: Route) -> None:
    url = route.request.url
    path = urlparse(url).path

    if path == "/calendar-ui":
        route.continue_()
        return

    if path == "/users/me":
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"id": 1, "email": "ui-smoke@example.com", "role": "admin"}),
        )
        return

    # Keep frontend from redirecting to /login during smoke verification.
    if path.startswith(("/accounts", "/calendar", "/events", "/notes", "/users")):
        body = {}
        if path.endswith("/list") or path.endswith("/all") or path.endswith("/events"):
            body = []
        if path == "/calendar/publish":
            body = {"status": "success", "published": 0, "deleted": 0, "failed": 0, "affected_accounts": []}
        route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
        return

    route.continue_()


def main(base_url: str) -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.route("**/*", _mock_api)
        page.add_init_script("localStorage.setItem('token', 'frontend-dom-smoke-token')")

        page.goto(f"{base_url.rstrip('/')}/calendar-ui", wait_until="domcontentloaded")
        page.wait_for_selector("#createBtn", timeout=10000)
        page.wait_for_selector("#createNewEventBtn", state="attached", timeout=10000)
        page.wait_for_selector("#accountsBtn", timeout=10000)
        page.wait_for_timeout(1200)

        # ✅ Create is a split button: opening it must reveal the dropdown before
        # its "Create Event" item can be clicked, matching real user interaction.
        page.locator("#createBtn").click()
        page.wait_for_selector("#createNewEventBtn", state="visible", timeout=5000)
        page.locator("#createNewEventBtn").click()
        page.wait_for_selector("#createEventModal.show", timeout=5000)
        create_modal_open = page.evaluate(
            "() => document.getElementById('createEventModal')?.classList.contains('show') === true"
        )
        page.locator("#cancelEventBtn").click()
        page.wait_for_selector("#createEventModal:not(.show)", timeout=5000)

        # ✅ Escape closes the open Create dropdown.
        page.locator("#createBtn").click()
        page.wait_for_selector("#createNewEventBtn", state="visible", timeout=5000)
        page.keyboard.press("Escape")
        page.wait_for_selector("#createNewEventBtn", state="hidden", timeout=5000)

        # ✅ Clicking outside the open Create dropdown closes it too.
        page.locator("#createBtn").click()
        page.wait_for_selector("#createNewEventBtn", state="visible", timeout=5000)
        page.locator("#calendar").click()
        page.wait_for_selector("#createNewEventBtn", state="hidden", timeout=5000)

        # ✅ Import Events menu item forwards the click to the hidden file input.
        page.evaluate(
            "() => { window.__importClicked = false; "
            "document.getElementById('importFileInput').addEventListener('click', "
            "() => { window.__importClicked = true; }); }"
        )
        page.locator("#createBtn").click()
        page.wait_for_selector("#importEventsMenuBtn", state="visible", timeout=5000)
        page.locator("#importEventsMenuBtn").click()
        import_clicked = page.evaluate("() => window.__importClicked === true")

        # ✅ PUBLISH FLOW — a real click through Publish → Accept must clear the pending queue,
        # even when the backend has nothing to send externally (event on no linked provider account).
        page.evaluate(
            r"""
            () => {
              window.trackPendingPublishChange({
                key: "event:9001",
                category: "event",
                summary: "Event created: Publish flow smoke fixture",
                eventId: 9001
              });
            }
            """
        )
        pending_before = page.evaluate("() => window.pendingPublishChanges.size")

        # ✅ Cancel in the review dialog must leave the pending item queued, not discard it.
        page.locator("#publishBtn").click()
        page.wait_for_selector(".publishReviewMenu", timeout=5000)
        page.locator("[data-publish-review-cancel]").click()
        page.wait_for_selector(".publishReviewMenu", state="hidden", timeout=5000)
        pending_after_cancel = page.evaluate("() => window.pendingPublishChanges.size")

        page.locator("#publishBtn").click()
        page.wait_for_selector(".publishReviewMenu", timeout=5000)
        page.locator("[data-publish-review-accept]").click()
        page.wait_for_function(
            "() => window.pendingPublishChanges.size === 0",
            timeout=5000,
        )
        pending_after = page.evaluate("() => window.pendingPublishChanges.size")

        data = page.evaluate(
            r"""
            () => {
              const pick = (id) => {
                const el = document.getElementById(id);
                if (!el) return { exists: false };
                return {
                  exists: true,
                  hasSvg: !!el.querySelector('svg'),
                  label: (el.querySelector('.btnLabel')?.textContent || '').trim(),
                  text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
                };
              };
              return {
                path: window.location.pathname,
                title: document.title,
                createBtn: pick('createBtn'),
                accountsBtn: pick('accountsBtn')
              };
            }
            """
        )
        data["createModalOpen"] = create_modal_open
        data["importClicked"] = import_clicked
        data["pendingAfterCancel"] = pending_after_cancel

        browser.close()

    print(json.dumps(data, indent=2))

    errors: list[str] = []
    if data.get("path") != "/calendar-ui":
        errors.append(f"unexpected path: {data.get('path')}")
    if not data["createBtn"]["exists"]:
        errors.append("createBtn missing")
    if not data["accountsBtn"]["exists"]:
        errors.append("accountsBtn missing")
    if not data["createBtn"].get("hasSvg"):
        errors.append("createBtn icon svg missing")
    if not data["accountsBtn"].get("hasSvg"):
        errors.append("accountsBtn icon svg missing")
    if data["createBtn"].get("label") != "Create":
        errors.append(f"create label mismatch: {data['createBtn'].get('label')}")
    if data["accountsBtn"].get("label") != "Accounts":
        errors.append(f"accounts label mismatch: {data['accountsBtn'].get('label')}")
    if not data.get("createModalOpen"):
        errors.append("Create Event menu action did not open the modal")
    if pending_before != 1:
        errors.append(f"pending publish queue did not register the fixture: {pending_before}")
    if data.get("pendingAfterCancel") != 1:
        errors.append(f"Publish Cancel discarded the pending item: {data.get('pendingAfterCancel')}")
    if pending_after != 0:
        errors.append(f"Publish Accept did not clear the pending queue: {pending_after}")
    if not data.get("importClicked"):
        errors.append("Import Events menu action did not forward the click to the file input")

    if errors:
        print("FRONTEND_VERIFY_FAILED")
        for err in errors:
            print("-", err)
        return 2

    print("FRONTEND_VERIFY_OK")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=DEFAULT_BASE)
    raise SystemExit(main(parser.parse_args().base_url))

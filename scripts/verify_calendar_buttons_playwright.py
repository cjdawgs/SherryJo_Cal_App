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
        page.wait_for_selector("#createNewEventBtn", timeout=10000)
        page.wait_for_selector("#accountsBtn", timeout=10000)
        page.wait_for_timeout(1200)
        page.locator("#createNewEventBtn").click()
        page.wait_for_selector("#createEventModal.show", timeout=5000)

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
                accountsBtn: pick('accountsBtn'),
                createModalOpen: document.getElementById('createEventModal')?.classList.contains('show') === true
              };
            }
            """
        )

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

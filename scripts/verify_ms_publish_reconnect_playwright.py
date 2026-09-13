"""
Proves the client-side "Microsoft publish failed -> reconnect" flow end-to-end
without a real Microsoft OAuth login, by mocking:
  - GET  /calendar/unified   -> one unpublished event for a connected MS account
  - POST /calendar/publish   -> the real no_token failure contract
  - GET  /accounts           -> the same MS account reporting status=error
  - GET  /ms/login           -> a stand-in for the real Microsoft consent redirect

Verifies:
  1. Confirm Publish surfaces "No valid token for microsoft:<email>" with a
     resolution link to /accounts/ui?remedy_provider=microsoft&remedy_account=...
  2. Clicking that link lands on /accounts/ui, which highlights the matching
     account card and shows a Reconnect button.
  3. Clicking Reconnect navigates to /ms/login with the expected reconnect params.

Run against a live dev server (default http://127.0.0.1:8000).
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from playwright.sync_api import Route, sync_playwright

DEFAULT_BASE = "http://127.0.0.1:8000"

MS_EMAIL = "chipjohansson@outlook.com"
MS_KEY = f"microsoft:{MS_EMAIL}"
EVENT_ID = 4242

ACCOUNTS_PAYLOAD = [
    {
        "id": 9,
        "provider": "microsoft",
        "account_email": MS_EMAIL,
        "status": "error",
        "is_primary": False,
        "sync_enabled": True,
        "token_issue": {
            "code": "token_invalid",
            "message": "Microsoft token invalid or expired.",
            "requires_admin": False,
            "user_remediable": True,
            "recommended_action": "reconnect",
            "recommended_label": "Reconnect",
            "resolution_steps": ["Click Reconnect", "Complete Microsoft consent", "Retry publish"],
        },
    }
]


def _event_payload() -> dict:
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    start = now + timedelta(hours=1)
    end = start + timedelta(hours=1)
    return {
        "id": EVENT_ID,
        "title": "MS Publish Reconnect Smoke Event",
        "start": start.isoformat(),
        "end": end.isoformat(),
        "source": "local",
        "account_email": "local",
        "external_ids": {},
        "color": None,
        "color_enabled": False,
    }


def _publish_failure_payload() -> dict:
    message = f"No valid token for {MS_KEY}"
    return {
        "status": "success",
        "published": 0,
        "created": 0,
        "deleted": 0,
        "failed": 1,
        "total_events": 1,
        "affected_accounts": [],
        "warnings": [message],
        "account_results": [
            {
                "target_key": MS_KEY,
                "provider": "microsoft",
                "account_email": MS_EMAIL,
                "linked": False,
                "action": "create",
                "ok": False,
                "status": "no_token",
                "message": message,
            }
        ],
    }


def _json(route: Route, body: dict | list, status: int = 200) -> None:
    route.fulfill(status=status, content_type="application/json", body=json.dumps(body))


def make_router(requests_log: list[str]):
    def _router(route: Route) -> None:
        request = route.request
        url = request.url
        path = urlparse(url).path
        method = request.method
        requests_log.append(f"{method} {path}")

        if path in ("/calendar-ui", "/accounts/ui") or path.startswith("/static/"):
            route.continue_()
            return

        if path == "/users/me":
            _json(route, {"id": 1, "email": "ui-smoke@example.com", "role": "admin"})
            return

        if path == "/calendar/unified" and method == "GET":
            _json(route, {"events": [_event_payload()], "account_status": {}, "account_event_totals": {}})
            return

        if path == "/calendar/publish" and method == "POST":
            _json(route, _publish_failure_payload())
            return

        if path == "/accounts" and method == "GET":
            _json(route, ACCOUNTS_PAYLOAD)
            return

        if path == "/accounts/sync-status":
            _json(route, {"accounts": [], "scheduler": {}})
            return

        if path == "/accounts/sync-rollups":
            _json(route, {"rows": [], "current_week": {"rows": []}})
            return

        if path == "/ms/login":
            route.fulfill(status=200, content_type="text/html", body="<html><body>ms-login-stub</body></html>")
            return

        if path.startswith(("/accounts", "/calendar", "/events", "/notes", "/users")):
            _json(route, [] if method == "GET" else {})
            return

        route.continue_()

    return _router


def main(base_url: str) -> int:
    requests_log: list[str] = []
    failures: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.route("**/*", make_router(requests_log))
        page.add_init_script("localStorage.setItem('token', 'ms-reconnect-smoke-token')")

        # ── Step 1: publish failure surfaces the remediation link ──────────
        page.goto(f"{base_url.rstrip('/')}/calendar-ui", wait_until="domcontentloaded")
        page.wait_for_selector(".fc-event", timeout=15000)
        page.locator(".fc-event").first.dblclick()
        page.wait_for_selector("#createEventModal.show", timeout=5000)

        checkbox = page.locator(f'#eventPublishTargets input[data-publish-account-key][value="{MS_KEY}"]')
        checkbox.wait_for(state="visible", timeout=5000)
        checkbox.check()

        page.locator("#publishEventBtn").click()
        page.wait_for_selector("#publishConfirmDialog.show", timeout=5000)
        page.locator("#confirmPublishEventBtn").click()

        remediation_link = page.locator("#publishConfirmSummary a")
        page.wait_for_selector("#publishConfirmSummary a", timeout=5000)
        href = remediation_link.get_attribute("href") or ""
        summary_text = page.locator("#publishConfirmSummary").inner_text()

        if "No valid token for microsoft" not in summary_text:
            failures.append(f"Publish failure message missing expected text. Got: {summary_text!r}")
        if "/accounts/ui?remedy_provider=microsoft" not in href:
            failures.append(f"Remediation link missing remedy_provider=microsoft. Got href: {href!r}")
        if f"remedy_account={MS_EMAIL.replace('@', '%40')}" not in href:
            failures.append(f"Remediation link missing remedy_account for {MS_EMAIL}. Got href: {href!r}")
        if "remedy_action=reconnect" not in href:
            # A missing/invalid token can't be fixed by Verify Access/Retry, so the
            # no-token failure must route straight to Reconnect, not verify_access.
            failures.append(f"Remediation link should route straight to reconnect for a no-token failure. Got href: {href!r}")

        # ── Step 2: following the link highlights the account + shows Reconnect ──
        page.goto(f"{base_url.rstrip('/')}{href}", wait_until="domcontentloaded")
        account_card = page.locator(f'.account[data-account-key="{MS_KEY}"]')
        account_card.wait_for(state="visible", timeout=8000)

        box_shadow = account_card.evaluate("(el) => el.style.boxShadow")
        if not box_shadow:
            failures.append("Remediation target account card was not visually highlighted (missing boxShadow).")

        error_banner = page.locator("#error").inner_text()
        if "Resolution target" not in error_banner or MS_KEY not in error_banner:
            failures.append(f"Expected resolution-target guidance message. Got: {error_banner!r}")
        if "Click Reconnect" not in error_banner:
            failures.append(f"No-token failures must guide straight to Reconnect, not Verify Access first. Got: {error_banner!r}")

        reconnect_btn = account_card.locator('[data-action="reconnect"]')
        retry_btn = account_card.locator('[data-action="retry"]')
        if retry_btn.count() != 0:
            failures.append("Reconnect remediation must not offer Verify Access/Retry for a tokenless account.")
        if reconnect_btn.count() == 0:
            failures.append("Reconnect button was not offered for the failed Microsoft account.")
        else:
            # ── Step 3: clicking Reconnect navigates to the real MS OAuth entrypoint ──
            with page.expect_navigation(timeout=5000):
                reconnect_btn.click()
            final_url = page.url
            if "/ms/login" not in final_url:
                failures.append(f"Reconnect click did not navigate to /ms/login. Got: {final_url}")
            if f"reconnect={MS_EMAIL.replace('@', '%40')}" not in final_url:
                failures.append(f"Reconnect URL missing reconnect param for {MS_EMAIL}. Got: {final_url}")

        if any(request.endswith("/retry") for request in requests_log):
            failures.append("Reconnect remediation incorrectly sent an account retry request.")

        browser.close()

    if failures:
        print("❌ MS publish reconnect flow verification FAILED:")
        for item in failures:
            print(f"  - {item}")
        return 1

    print("✅ MS publish -> reconnect flow verified end-to-end (mocked OAuth):")
    print(f"  - Publish failure message: {summary_text.strip()}")
    print(f"  - Remediation link: {href}")
    print(f"  - Reconnect target navigated to: {final_url}")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default=DEFAULT_BASE)
    args = parser.parse_args()
    raise SystemExit(main(args.base_url))

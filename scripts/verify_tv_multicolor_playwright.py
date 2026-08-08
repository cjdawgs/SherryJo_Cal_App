from __future__ import annotations

import json
from datetime import datetime, timezone
import sys
from urllib.parse import urlparse
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from playwright.sync_api import Route, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import SessionLocal
from app.main import app
from app.models import Event, OAuthAccount
from app.security import decode_token

BASE = "http://127.0.0.1:8000"


def _hex_to_rgb(hex_value: str) -> tuple[int, int, int]:
    raw = hex_value.strip().lstrip('#')
    if len(raw) == 3:
        raw = ''.join(ch * 2 for ch in raw)
    return int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16)


def _seed_multi_color_data() -> tuple[str, dict[str, dict[str, str]]]:
    client = TestClient(app)
    suffix = uuid4().hex[:8]
    email = f"tv_multi_color_smoke_{suffix}@example.com"
    username = f"tv_multi_color_smoke_{suffix}"

    client.post(
        "/auth/register",
        json={"username": username, "email": email, "password": "tvpass123"},
    )
    login = client.post("/auth/login", json={"email": email, "password": "tvpass123"})
    token = login.json()["access_token"]
    user_id = decode_token(token)["user_id"]

    seed_accounts = [
        ("google", "alpha-smoke@realmail.test", "#FF5500", "Alpha Google"),
        ("microsoft", "beta-smoke@realmail.test", "#00AA88", "Beta Microsoft"),
        ("apple", "gamma-smoke@realmail.test", "#7755FF", "Gamma Apple"),
    ]
    seed_events = [
        ("Alpha Event", "google", "alpha-smoke@realmail.test", "#FF5500", datetime(2026, 7, 28, 9, 0, tzinfo=timezone.utc)),
        ("Beta Event", "microsoft", "beta-smoke@realmail.test", "#00AA88", datetime(2026, 7, 29, 10, 0, tzinfo=timezone.utc)),
        ("Gamma Event", "apple", "gamma-smoke@realmail.test", "#7755FF", datetime(2026, 7, 30, 11, 0, tzinfo=timezone.utc)),
        ("Delta Event", "google", "delta-smoke@realmail.test", "#22AA77", datetime(2026, 7, 31, 12, 0, tzinfo=timezone.utc)),
    ]

    with SessionLocal() as db:
        for provider, account_email, color, provider_id in seed_accounts:
            db.add(
                OAuthAccount(
                    user_id=user_id,
                    provider=provider,
                    provider_id=provider_id,
                    account_email=account_email,
                    access_token="token",
                    refresh_token="refresh",
                    sync_enabled=True,
                    color=color,
                )
            )
        for title, source, account_email, color, start in seed_events:
            db.add(
                Event(
                    title=title,
                    start_time=start,
                    end_time=start.replace(hour=start.hour + 1),
                    owner_id=user_id,
                    source=source,
                    account_email=account_email,
                    color=color,
                    color_enabled=True,
                    external_ids={f"{source}:{account_email}": f"evt-{title.lower().split()[0]}"},
                )
            )
        db.commit()

    client.patch(
        "/tv/state",
        json={"selectedDate": "2026-07-28", "currentView": "month"},
        headers={"Authorization": f"Bearer {token}"},
    )
    pairing = client.post("/tv/generate-code", headers={"Authorization": f"Bearer {token}"})
    pairing_code = pairing.json()["pairingCode"]
    pair_res = client.post("/tv/pair", json={"pairingCode": pairing_code})
    tv_token = pair_res.json()["token"]
    payload = client.get(
        "/tv/events?selectedDate=2026-07-28&currentView=month",
        headers={"Authorization": f"Bearer {token}"},
    ).json()
    event_index: dict[str, dict[str, str]] = {}
    for day in payload.get("days", []):
        for event in day.get("events", []):
            title = str(event.get("title") or "")
            if title in {"Alpha Event", "Beta Event", "Gamma Event", "Delta Event"}:
                event_index[title] = {
                    "id": str(event.get("id") or ""),
                    "color": str(event.get("color") or ""),
                    "account_key": str(event.get("account_key") or ""),
                }
    return tv_token, event_index


def _mock_api(route: Route) -> None:
    path = urlparse(route.request.url).path
    if path == "/users/me":
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"id": 1, "email": "tv-smoke@example.com", "role": "admin"}),
        )
        return
    route.continue_()


def _assert_colorized_card(
    page,
    selector: str,
    title: str,
    expected_color: str,
) -> None:
    card = page.locator(selector).filter(has_text=title).first
    card.wait_for(timeout=5000)
    red, green, blue = _hex_to_rgb(expected_color)
    expected_background = f"rgba({red}, {green}, {blue}, 0.2)"
    expected_border_prefix = f"rgba({red}, {green}, {blue},"
    data = card.evaluate(
        """
        (el) => {
          const style = getComputedStyle(el);
          return {
                        text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
            style: el.getAttribute('style') || '',
            background: style.backgroundColor,
            border: style.borderTopColor,
          };
        }
        """
    )
    normalized_style = data["style"].replace(" ", "")
    normalized_background = data["background"].replace(" ", "")
    normalized_border = data["border"].replace(" ", "")
    if expected_background.replace(" ", "") not in normalized_style and expected_background.replace(" ", "") not in normalized_background:
        raise AssertionError(f"{title} not colorized as expected: {data}")
    if expected_border_prefix.replace(" ", "") not in normalized_style and expected_border_prefix.replace(" ", "") not in normalized_border:
        raise AssertionError(f"{title} border not colorized as expected: {data}")
    border_alpha = None
    for candidate in (normalized_style, normalized_border):
        if candidate.startswith(f"rgba({red},{green},{blue},"):
            try:
                border_alpha = float(candidate.rsplit(",", 1)[-1].rstrip(")"))
            except ValueError:
                border_alpha = None
            break
    if border_alpha is not None and border_alpha < 0.5:
        raise AssertionError(f"{title} border opacity too low: {data}")


def _assert_day_week_rail_layout(page) -> dict[str, float | int | str]:
    layout = page.locator(".tv-right-rail.calendar-rail").evaluate(
        """
        (rail) => {
          const weekList = rail.querySelector('.tv-right-week-list');
          if (!weekList) throw new Error('Missing week list');
          const railRect = rail.getBoundingClientRect();
          const weekRect = weekList.getBoundingClientRect();
          const style = getComputedStyle(weekList);
          return {
            groupCount: weekList.querySelectorAll('.tv-right-day-group').length,
            railHeight: railRect.height,
            weekHeight: weekRect.height,
            bottomGap: railRect.bottom - weekRect.bottom,
            overflowY: style.overflowY,
          };
        }
        """
    )
    if layout["groupCount"] != 7:
        raise AssertionError(f"Day sidebar should render seven week groups: {layout}")
    if layout["weekHeight"] < layout["railHeight"] * 0.45:
        raise AssertionError(f"Week list does not fill the available rail space: {layout}")
    if not 0 <= layout["bottomGap"] <= 12:
        raise AssertionError(f"Week list does not reach the rail bottom: {layout}")
    if layout["overflowY"] not in {"auto", "scroll"}:
        raise AssertionError(f"Week list is not vertically scrollable: {layout}")
    return layout


def main() -> int:
    token, event_index = _seed_multi_color_data()
    month_expectations = [
        ("Alpha Event", "#FF5500"),
        ("Beta Event", "#00AA88"),
        ("Gamma Event", "#7755FF"),
    ]
    focused_day_expectation = [("Delta Event", "#22AA77")]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1600, "height": 768})
        page.route("**/users/me", _mock_api)
        page.add_init_script("localStorage.setItem('tv_token', '%s');" % token)
        page.goto(f"{BASE}/tv/dashboard", wait_until="domcontentloaded")
        page.wait_for_timeout(1800)

        results = {"legend": None}

        page.locator("[data-control='view-month']").click()
        page.wait_for_timeout(1000)
        month_result = {}
        for title, color in month_expectations:
            _assert_colorized_card(page, ".tv-month-preview", title, color)
            month_result[title] = True
        results["month"] = month_result

        page.locator(".tv-month-cell.selected").click()
        page.wait_for_timeout(1000)

        page.locator("[data-control='view-day']").click()
        page.wait_for_timeout(1000)
        day_result = {}
        for title, color in focused_day_expectation:
            _assert_colorized_card(page, ".tv-day-event-card", title, color)
            day_result[title] = True
        day_result["weekRail"] = _assert_day_week_rail_layout(page)
        results["day"] = day_result

        page.locator("[data-control='view-week']").click()
        page.wait_for_timeout(1000)
        week_result = {}
        for title, color in focused_day_expectation:
            _assert_colorized_card(page, ".tv-item", title, color)
            week_result[title] = True
        results["week"] = week_result

        page.locator("[data-control='view-three-day']").click()
        page.wait_for_timeout(1000)
        three_day_result = {}
        for title, color in focused_day_expectation:
            _assert_colorized_card(page, ".tv-item", title, color)
            three_day_result[title] = True
        results["3-day"] = three_day_result

        page.locator("[data-control='view-month']").click()
        page.wait_for_timeout(1000)
        page.locator(".tv-month-cell.selected").click()
        page.wait_for_timeout(1000)
        sidebar_result = {}
        for title, color in focused_day_expectation:
            _assert_colorized_card(page, ".tv-right-rail.month-popout .tv-right-item", title, color)
            sidebar_result[title] = True
        results["month-sidebar"] = sidebar_result

        legend = page.locator('.tv-account-chip')
        legend.first.wait_for(timeout=5000)
        results["legend"] = legend.count()
        browser.close()

    print(json.dumps(results, indent=2))
    print("TV_MULTI_COLOR_VERIFY_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
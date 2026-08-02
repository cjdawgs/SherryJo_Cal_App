"""Run reversible authenticated smoke checks across Render and Cloudflare."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote, urlsplit

import websockets


DEFAULT_RENDER_URL = "https://sherryjo-cal-app.onrender.com"
DEFAULT_CLOUDFLARE_URL = "https://sherryjo-calendar-edge.realty-cal.workers.dev"
TOKEN_ENV = "SHERRYJO_SMOKE_TOKEN"
EMAIL_ENV = "SHERRYJO_SMOKE_EMAIL"
PASSWORD_ENV = "SHERRYJO_SMOKE_PASSWORD"
USER_AGENT = "curl/8.10.1 SherryJo-authenticated-smoke/1.0"


class SmokeFailure(RuntimeError):
    pass


@dataclass(frozen=True)
class HttpResult:
    status: int
    body: bytes

    def json(self) -> Any:
        try:
            return json.loads(self.body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SmokeFailure(f"HTTP {self.status} returned invalid JSON") from exc


def _validate_target(url: str, allow_remote: bool) -> str:
    normalized = url.rstrip("/")
    parsed = urlsplit(normalized)
    if not parsed.scheme or not parsed.hostname:
        raise ValueError(f"Invalid target URL: {url}")
    is_local = parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    if not is_local and not allow_remote:
        raise ValueError("Remote smoke targets require --allow-remote")
    if not is_local and parsed.scheme != "https":
        raise ValueError("Remote smoke targets must use HTTPS")
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Smoke targets must use HTTP or HTTPS")
    return normalized


def _request(
    origin: str,
    token: str,
    method: str,
    path: str,
    *,
    payload: dict[str, Any] | None = None,
    body: bytes | None = None,
    content_type: str | None = None,
) -> HttpResult:
    headers = {
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request_body = body
    if payload is not None:
        request_body = json.dumps(payload).encode("utf-8")
        content_type = "application/json"
    if content_type:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(
        f"{origin}{path}",
        data=request_body,
        headers=headers,
        method=method,
    )
    try:
        response = urllib.request.urlopen(request, timeout=45)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return HttpResult(status=response.status, body=response.read())


def _expect(result: HttpResult, expected_status: int, check: str) -> Any:
    if result.status != expected_status:
        raise SmokeFailure(f"{check} returned HTTP {result.status}; expected {expected_status}")
    return result.json()


def _login(origin: str, email: str, password: str) -> str:
    payload = _expect(
        _request(
            origin,
            "",
            "POST",
            "/auth/login",
            payload={"email": email, "password": password},
        ),
        200,
        "smoke account login",
    )
    token = payload.get("access_token") if isinstance(payload, dict) else None
    if not isinstance(token, str) or not token:
        raise SmokeFailure("Smoke account login omitted the access token")
    return token


def _event_by_id(events: Any, event_id: int, check: str) -> dict[str, Any]:
    if not isinstance(events, list):
        raise SmokeFailure(f"{check} did not return an event list")
    event = next(
        (
            item
            for item in events
            if isinstance(item, dict) and str(item.get("id")) == str(event_id)
        ),
        None,
    )
    if event is None:
        raise SmokeFailure(f"{check} did not contain the smoke event")
    return event


def _note_by_id(notes: Any, note_id: str, check: str) -> dict[str, Any]:
    if not isinstance(notes, list):
        raise SmokeFailure(f"{check} did not return a note list")
    note = next(
        (
            item
            for item in notes
            if isinstance(item, dict) and str(item.get("id")) == note_id
        ),
        None,
    )
    if note is None:
        raise SmokeFailure(f"{check} did not contain the smoke note")
    return note


def _verify_operational_reads(origin: str, token: str, prefix: str) -> list[str]:
    tasks = _expect(_request(origin, token, "GET", "/tasks/"), 200, f"{prefix} task read")
    if not isinstance(tasks, list):
        raise SmokeFailure(f"{prefix} task read did not return a list")

    accounts = _expect(_request(origin, token, "GET", "/accounts"), 200, f"{prefix} account read")
    if not isinstance(accounts, list):
        raise SmokeFailure(f"{prefix} account read did not return a list")

    sync_status = _expect(
        _request(origin, token, "GET", "/accounts/sync-status"),
        200,
        f"{prefix} scheduler status",
    )
    scheduler = sync_status.get("scheduler") if isinstance(sync_status, dict) else None
    if not isinstance(scheduler, dict) or scheduler.get("running") is not True:
        raise SmokeFailure(f"{prefix} scheduler is not running")

    tv_version = _expect(_request(origin, token, "GET", "/tv/version"), 200, f"{prefix} TV version")
    if not isinstance(tv_version, dict) or not str(tv_version.get("appVersion") or "").strip():
        raise SmokeFailure(f"{prefix} TV version omitted appVersion")

    tv_state = _expect(_request(origin, token, "GET", "/tv/state"), 200, f"{prefix} TV state")
    if not isinstance(tv_state, dict) or "selectedDate" not in tv_state or not tv_state.get("currentView"):
        raise SmokeFailure(f"{prefix} TV state returned an invalid contract")

    asset = _request(origin, "", "GET", "/static/calendar.js")
    if asset.status != 200:
        raise SmokeFailure(f"{prefix} calendar asset returned HTTP {asset.status}; expected 200")
    if len(asset.body) < 100 or b"window.selectedDate" not in asset.body:
        raise SmokeFailure(f"{prefix} calendar asset returned unexpected content")

    return [
        f"{prefix}_tasks_read",
        f"{prefix}_accounts_read",
        f"{prefix}_scheduler_running",
        f"{prefix}_tv_version",
        f"{prefix}_tv_state",
        f"{prefix}_calendar_asset",
    ]


def _invalid_upload(origin: str, token: str) -> None:
    boundary = "----SherryJoAuthenticatedSmoke"
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="smoke.invalid"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
        "not-an-import-format\r\n"
        f"--{boundary}--\r\n"
    ).encode("utf-8")
    result = _request(
        origin,
        token,
        "POST",
        "/calendar/import-events",
        body=body,
        content_type=f"multipart/form-data; boundary={boundary}",
    )
    _expect(result, 422, "invalid upload rejection")


async def _websocket_echo(origin: str, token: str, message: str) -> None:
    ticket_response = _request(origin, token, "POST", "/ws/ticket")
    ticket_payload = _expect(ticket_response, 200, f"WebSocket ticket ({origin})")
    ticket = ticket_payload.get("ticket") if isinstance(ticket_payload, dict) else None
    if not isinstance(ticket, str) or not ticket:
        raise SmokeFailure("WebSocket ticket response omitted the ticket")
    scheme = "wss" if origin.startswith("https://") else "ws"
    endpoint = origin.split("://", 1)[1]
    async with websockets.connect(
        f"{scheme}://{endpoint}/ws?ticket={quote(ticket)}",
        open_timeout=30,
        proxy=None,
        user_agent_header=USER_AGENT,
    ) as websocket:
        await websocket.send(message)
        response = await asyncio.wait_for(websocket.recv(), timeout=15)
    if response != f"Update: {message}":
        raise SmokeFailure("WebSocket echo response did not match")


def _cleanup_event(origins: tuple[str, ...], token: str, event_id: int) -> list[str]:
    errors: list[str] = []
    for origin in origins:
        try:
            result = _request(origin, token, "DELETE", f"/calendar/event/{event_id}")
        except Exception as exc:
            errors.append(f"cleanup request failed for {origin}: {type(exc).__name__}")
            continue
        if result.status == 200:
            return []
        if result.status != 404:
            errors.append(f"cleanup returned HTTP {result.status} for {origin}")
    return errors or ["cleanup could not confirm deletion"]


async def run_authenticated_smoke(
    render_url: str,
    cloudflare_url: str,
    token: str,
    *,
    run_id: str | None = None,
) -> dict[str, Any]:
    identifier = run_id or uuid.uuid4().hex
    title = f"[SMOKE] {identifier}"
    updated_title = f"{title} updated"
    start = datetime.now(timezone.utc) + timedelta(days=30)
    event_id: int | None = None
    note_id: str | None = None
    note_date = start.date().isoformat()
    note_content = f"[SMOKE] note {identifier}"
    checks: list[str] = []
    failures: list[str] = []
    cleanup = {"attempted": False, "passed": False}

    try:
        created = _expect(
            _request(
                render_url,
                token,
                "POST",
                "/calendar/event",
                payload={
                    "title": title,
                    "description": "Reversible Cloudflare migration smoke fixture",
                    "start_time": start.isoformat(),
                    "end_time": (start + timedelta(minutes=15)).isoformat(),
                    "source": "local",
                    "account_email": "local",
                },
            ),
            200,
            "Render event create",
        )
        raw_event_id = created.get("event", {}).get("id") if isinstance(created, dict) else None
        event_id = int(raw_event_id)
        checks.append("render_create")

        cloudflare_events = _expect(
            _request(cloudflare_url, token, "GET", "/events/"),
            200,
            "Cloudflare event read",
        )
        if _event_by_id(cloudflare_events, event_id, "Cloudflare event read").get("title") != title:
            raise SmokeFailure("Cloudflare event read returned the wrong title")
        checks.append("cloudflare_read")

        updated = _expect(
            _request(
                cloudflare_url,
                token,
                "PUT",
                f"/calendar/event/{event_id}",
                payload={"title": updated_title},
            ),
            200,
            "Cloudflare event update",
        )
        if not isinstance(updated, dict) or updated.get("event", {}).get("title") != updated_title:
            raise SmokeFailure("Cloudflare event update returned the wrong title")
        checks.append("cloudflare_update")

        render_events = _expect(
            _request(render_url, token, "GET", "/events/"),
            200,
            "Render event read",
        )
        if _event_by_id(render_events, event_id, "Render event read").get("title") != updated_title:
            raise SmokeFailure("Render event read returned the wrong updated title")
        checks.append("render_read_after_update")

        created_note = _expect(
            _request(
                render_url,
                token,
                "POST",
                "/notes/",
                payload={
                    "date": note_date,
                    "event_id": event_id,
                    "content": note_content,
                },
            ),
            200,
            "Render note create",
        )
        raw_note_id = created_note.get("id") if isinstance(created_note, dict) else None
        if not raw_note_id:
            raise SmokeFailure("Render note create omitted the note id")
        note_id = str(raw_note_id)
        checks.append("render_note_create")

        cloudflare_notes = _expect(
            _request(cloudflare_url, token, "GET", f"/notes/?date={quote(note_date)}"),
            200,
            "Cloudflare note read",
        )
        if _note_by_id(cloudflare_notes, note_id, "Cloudflare note read").get("content") != note_content:
            raise SmokeFailure("Cloudflare note read returned the wrong content")
        checks.append("cloudflare_note_read")

        checks.extend(_verify_operational_reads(render_url, token, "render"))
        checks.extend(_verify_operational_reads(cloudflare_url, token, "cloudflare"))

        for origin, name in (
            (render_url, "render_invalid_upload_rejection"),
            (cloudflare_url, "cloudflare_invalid_upload_rejection"),
        ):
            _invalid_upload(origin, token)
            checks.append(name)

        for origin, name in (
            (render_url, "render_websocket_echo"),
            (cloudflare_url, "cloudflare_websocket_echo"),
        ):
            await _websocket_echo(origin, token, identifier)
            checks.append(name)
    except Exception as exc:
        failures.append(f"{type(exc).__name__}: {exc}")
    finally:
        if event_id is not None:
            cleanup["attempted"] = True
            cleanup_errors = _cleanup_event((cloudflare_url, render_url), token, event_id)
            if not cleanup_errors and note_id is not None:
                for origin in (cloudflare_url, render_url):
                    try:
                        notes = _expect(
                            _request(origin, token, "GET", f"/notes/?date={quote(note_date)}"),
                            200,
                            f"note cleanup verification ({origin})",
                        )
                        if isinstance(notes, list) and any(
                            isinstance(item, dict) and str(item.get("id")) == note_id
                            for item in notes
                        ):
                            cleanup_errors.append(f"cleanup left the smoke note at {origin}")
                    except Exception as exc:
                        cleanup_errors.append(
                            f"note cleanup verification failed for {origin}: {type(exc).__name__}"
                        )
                if not cleanup_errors:
                    checks.append("note_cleanup_verified")
            cleanup["passed"] = not cleanup_errors
            failures.extend(cleanup_errors)

    return {
        "run_id": identifier,
        "render_url": render_url,
        "cloudflare_url": cloudflare_url,
        "passed": not failures and cleanup["passed"],
        "checks": checks,
        "cleanup": cleanup,
        "failures": failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--render-url", default=DEFAULT_RENDER_URL)
    parser.add_argument("--cloudflare-url", default=DEFAULT_CLOUDFLARE_URL)
    parser.add_argument("--allow-remote", action="store_true")
    parser.add_argument("--json-output")
    args = parser.parse_args()

    try:
        render_url = _validate_target(args.render_url, args.allow_remote)
        cloudflare_url = _validate_target(args.cloudflare_url, args.allow_remote)
    except ValueError as exc:
        parser.error(str(exc))

    token = os.environ.get(TOKEN_ENV, "").strip()
    if not token:
        email = os.environ.get(EMAIL_ENV, "").strip()
        password = os.environ.get(PASSWORD_ENV, "")
        if not email or not password:
            parser.error(
                f"Set {EMAIL_ENV} and {PASSWORD_ENV}; credentials are not accepted as command arguments"
            )
        try:
            token = _login(render_url, email, password)
        except SmokeFailure as exc:
            parser.error(str(exc))

    report = asyncio.run(run_authenticated_smoke(render_url, cloudflare_url, token))
    output = json.dumps(report, indent=2)
    print(output)
    if args.json_output:
        with open(args.json_output, "w", encoding="utf-8") as handle:
            handle.write(output + "\n")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
import json
import os
import sys
import time
from urllib import error, request


RENDER_API_BASE = "https://api.render.com/v1"


def _http_json(method: str, url: str, token: str, payload=None):
    data = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }

    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = request.Request(url, data=data, headers=headers, method=method)

    try:
        with request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else {}
    except error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {"raw": body}
        return e.code, parsed


def _http_status(url: str):
    req = request.Request(url, method="GET")
    try:
        with request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return resp.status, body
    except error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return e.code, body
    except Exception as e:
        return 0, str(e)


def fail(msg: str, code: int = 1):
    print(f"ERROR: {msg}")
    sys.exit(code)


def main():
    token = os.getenv("RENDER_API_KEY", "").strip()
    service_id = os.getenv("RENDER_SERVICE_ID", "").strip()
    app_base = os.getenv("APP_BASE_URL", "https://sherryjo-cal-app.onrender.com").strip().rstrip("/")

    if not token:
        fail("RENDER_API_KEY is required in environment.")

    if not service_id:
        fail("RENDER_SERVICE_ID is required in environment.")

    print("Triggering deploy...")
    status, deploy_resp = _http_json(
        "POST",
        f"{RENDER_API_BASE}/services/{service_id}/deploys",
        token,
        payload={},
    )

    if status not in (200, 201, 202):
        fail(f"Failed to trigger deploy: HTTP {status} | {deploy_resp}")

    deploy_id = deploy_resp.get("id")
    if not deploy_id:
        # Some Render API paths return 202 with an empty body.
        # Fallback: query latest deploy and use its id.
        list_status, list_resp = _http_json(
            "GET",
            f"{RENDER_API_BASE}/services/{service_id}/deploys?limit=1",
            token,
        )

        if list_status != 200:
            fail(
                "Deploy was triggered but no deploy ID returned, and latest deploy lookup failed: "
                f"HTTP {list_status} | {list_resp}"
            )

        if isinstance(list_resp, list) and list_resp:
            first = list_resp[0]
            if isinstance(first, dict):
                deploy_id = first.get("id")
                if not deploy_id and isinstance(first.get("deploy"), dict):
                    deploy_id = first["deploy"].get("id")
        elif isinstance(list_resp, dict):
            items = list_resp.get("items") or list_resp.get("data") or []
            if isinstance(items, list) and items:
                first = items[0]
                if isinstance(first, dict):
                    deploy_id = first.get("id")
                    if not deploy_id and isinstance(first.get("deploy"), dict):
                        deploy_id = first["deploy"].get("id")

    if not deploy_id:
        fail(f"Deploy was triggered but no deploy ID could be resolved. Trigger response: {deploy_resp}")

    print(f"Deploy triggered: {deploy_id}")
    print("Polling deploy status...")

    max_wait_seconds = int(os.getenv("RENDER_DEPLOY_WAIT_SECONDS", "900"))
    start = time.time()
    last_status = "unknown"

    while True:
        s, d = _http_json(
            "GET",
            f"{RENDER_API_BASE}/services/{service_id}/deploys/{deploy_id}",
            token,
        )

        if s != 200:
            fail(f"Failed to query deploy status: HTTP {s} | {d}")

        deploy_status = str(d.get("status", "unknown")).lower()
        if deploy_status != last_status:
            print(f"Deploy status: {deploy_status}")
            last_status = deploy_status

        if deploy_status in {"live", "deployed", "success"}:
            print("Deploy reached live status.")
            break

        if deploy_status in {"failed", "canceled", "cancelled"}:
            fail(f"Deploy ended in non-success state: {deploy_status}")

        if time.time() - start > max_wait_seconds:
            fail(f"Timed out waiting for deploy to finish. Last status: {deploy_status}")

        time.sleep(10)

    print("Running post-deploy HTTP checks...")
    checks = [
        ("health", f"{app_base}/health", {200}),
        ("schema_health", f"{app_base}/health/schema", {200}),
    ]

    failed = []
    for name, url, ok_statuses in checks:
        code, body = _http_status(url)
        print(f"[{name}] {url} -> {code}")
        if code not in ok_statuses:
            failed.append((name, code, body[:400]))

    # Route-level non-500 sanity checks (auth may be required, so 401/403 are acceptable).
    protected_checks = [
        ("date_sticky", f"{app_base}/calendar/date-sticky"),
        ("sync", f"{app_base}/calendar/sync"),
    ]

    for name, url in protected_checks:
        code, body = _http_status(url)
        print(f"[{name}] {url} -> {code}")
        if code >= 500 or code == 0:
            failed.append((name, code, body[:400]))

    if failed:
        print("Post-deploy checks failed:")
        for name, code, snippet in failed:
            print(f"- {name}: status={code} body={snippet}")
        sys.exit(2)

    print("All post-deploy checks passed.")


if __name__ == "__main__":
    main()

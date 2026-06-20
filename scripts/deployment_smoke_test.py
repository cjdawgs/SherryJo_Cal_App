import argparse
import json
import sys
from urllib.parse import parse_qs, urlparse

import requests


def normalize_base_url(value: str) -> str:
    return value.strip().rstrip("/")


def print_check(name: str, ok: bool, detail: str) -> None:
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name}: {detail}")


def request_json(session: requests.Session, method: str, url: str, **kwargs):
    response = session.request(method=method, url=url, timeout=20, **kwargs)
    try:
        payload = response.json()
    except Exception:
        payload = None
    return response, payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Post-deploy smoke test for SherryJo Cal App over public URL.")
    parser.add_argument("--base-url", required=True, help="Public base URL, e.g. https://mytunnel.devtunnels.ms")
    parser.add_argument("--email", help="Optional login email for authenticated checks")
    parser.add_argument("--password", help="Optional login password for authenticated checks")
    parser.add_argument("--token", help="Optional pre-generated bearer token for OAuth redirect checks")
    args = parser.parse_args()

    base_url = normalize_base_url(args.base_url)
    session = requests.Session()

    print("=== Deployment Smoke Test ===")
    print(f"Target: {base_url}")

    failures = 0

    # 1) Health endpoint
    health_url = f"{base_url}/health"
    health_response, health_payload = request_json(session, "GET", health_url)
    health_ok = health_response.status_code == 200 and isinstance(health_payload, dict) and health_payload.get("status") == "ok"
    print_check("Health endpoint", health_ok, f"status={health_response.status_code}, body={health_payload}")
    failures += 0 if health_ok else 1

    # 2) Login page availability
    login_page = session.get(f"{base_url}/login", timeout=20)
    login_ok = login_page.status_code == 200 and "Login" in login_page.text
    print_check("Login page", login_ok, f"status={login_page.status_code}")
    failures += 0 if login_ok else 1

    token = args.token

    # 3) Optional login for token acquisition
    if not token and args.email and args.password:
        login_api_url = f"{base_url}/auth/login"
        login_response, login_payload = request_json(
            session,
            "POST",
            login_api_url,
            json={"email": args.email, "password": args.password},
        )
        token = (login_payload or {}).get("access_token") if isinstance(login_payload, dict) else None
        login_api_ok = login_response.status_code == 200 and bool(token)
        print_check("Auth login API", login_api_ok, f"status={login_response.status_code}")
        failures += 0 if login_api_ok else 1

    # 4) OAuth redirect URI validation (requires token)
    if token:
        oauth_url = f"{base_url}/auth/google/login"
        oauth_response = session.get(
            oauth_url,
            params={"token": token},
            allow_redirects=False,
            timeout=20,
        )
        location = oauth_response.headers.get("Location", "")
        query = parse_qs(urlparse(location).query)
        redirect_uri = (query.get("redirect_uri") or [""])[0]
        oauth_ok = oauth_response.status_code in {302, 307} and redirect_uri == f"{base_url}/auth/google/callback"
        print_check(
            "Google OAuth redirect_uri",
            oauth_ok,
            f"status={oauth_response.status_code}, redirect_uri={redirect_uri}",
        )
        failures += 0 if oauth_ok else 1

        # 5) Microsoft OAuth redirect URI validation
        ms_oauth_url = f"{base_url}/ms/login"
        ms_oauth_response = session.get(
            ms_oauth_url,
            params={"token": token},
            allow_redirects=False,
            timeout=20,
        )
        ms_location = ms_oauth_response.headers.get("Location", "")
        ms_query = parse_qs(urlparse(ms_location).query)
        ms_redirect_uri = (ms_query.get("redirect_uri") or [""])[0]
        ms_oauth_ok = ms_oauth_response.status_code in {302, 307} and ms_redirect_uri == f"{base_url}/ms/callback"
        print_check(
            "Microsoft OAuth redirect_uri",
            ms_oauth_ok,
            f"status={ms_oauth_response.status_code}, redirect_uri={ms_redirect_uri}",
        )
        failures += 0 if ms_oauth_ok else 1

        # 6) Unauthorized baseline check for accounts with bad token
        bad_accounts = session.get(
            f"{base_url}/accounts",
            headers={"Authorization": "Bearer invalid_token"},
            timeout=20,
        )
        unauthorized_ok = bad_accounts.status_code == 401
        print_check("Accounts invalid-token guard", unauthorized_ok, f"status={bad_accounts.status_code}")
        failures += 0 if unauthorized_ok else 1

        # 7) Authenticated accounts sample
        accounts_response, accounts_payload = request_json(
            session,
            "GET",
            f"{base_url}/accounts",
            headers={"Authorization": f"Bearer {token}"},
        )
        accounts_ok = accounts_response.status_code == 200 and isinstance(accounts_payload, list)
        detail = f"status={accounts_response.status_code}, accounts={len(accounts_payload) if isinstance(accounts_payload, list) else 'n/a'}"
        print_check("Accounts API authenticated", accounts_ok, detail)
        failures += 0 if accounts_ok else 1

        # 8) Retry simulation if at least one account exists
        if accounts_ok and accounts_payload:
            first_account = accounts_payload[0]
            account_id = first_account.get("id")
            retry_response, retry_payload = request_json(
                session,
                "POST",
                f"{base_url}/accounts/{account_id}/retry",
                headers={"Authorization": f"Bearer {token}"},
            )
            retry_ok = retry_response.status_code == 200 and isinstance(retry_payload, dict) and retry_payload.get("success") is True
            print_check(
                "Retry endpoint",
                retry_ok,
                f"status={retry_response.status_code}, success={(retry_payload or {}).get('success')}",
            )
            failures += 0 if retry_ok else 1

            if isinstance(retry_payload, dict):
                print("Retry payload:")
                print(json.dumps(retry_payload, indent=2))
    else:
        print("[INFO] Token-dependent checks skipped. Provide --token or --email/--password.")

    print("=== Smoke Test Complete ===")
    if failures:
        print(f"Result: FAIL ({failures} checks failed)")
        return 1

    print("Result: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())

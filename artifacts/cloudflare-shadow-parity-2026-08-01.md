# Cloudflare Shadow Parity Evidence

Date: 2026-08-01

## Verdict

- Phase-zero Cloudflare-to-Render reverse-proxy parity: **PASS**
- Cloudflare public-host OAuth cutover: **BLOCKED**
- Production database safety: **PASS**

The Worker currently provides a behaviorally equivalent edge route to the Render FastAPI application. Render remains the application and authentication authority, and Supabase PostgreSQL remains the sole production database.

No commit or push was performed as part of this validation.

## Automated Live Gate

The repeatable harness in `deployment/shadow_parity.py` passed 16 of 16 checks against:

- Render: `https://sherryjo-cal-app.onrender.com`
- Cloudflare: `https://retired-cloudflare-worker.invalid` (retired historical target)

Coverage includes health GET/HEAD, cookies, redirects, static and large responses, invalid login, protected API rejection, multipart authentication rejection, CORS preflight parity, Google and Microsoft invalid-state callback rejection, invalid-token WebSocket rejection, and Worker-native route ownership.

Machine-readable evidence is stored in `artifacts/cloudflare-shadow-parity-2026-08-01.json`.

## First Worker-Native Application Route

`GET /api/platform/status` now terminates inside the Worker and returns:

```json
{
	"status": "ok",
	"platform": "cloudflare-worker",
	"mode": "worker-native"
}
```

The route has no authentication, database, or Render dependency. Its unit test makes any origin fetch fail and confirms that no fetch occurs. Worker tests passed 5 of 5, syntax validation passed, Wrangler dry-run passed, and the live endpoint returned 200 with the expected JSON and `cache-control: no-store`.

Deployed Worker version: `be60f8d2-ea34-4739-82ed-0eef699f80a5`.

The prior known-good rollback target is `60ba0d70-6516-445f-ae92-579620ad4a6f`. The verified rollback command is:

```powershell
wrangler rollback 60ba0d70-6516-445f-ae92-579620ad4a6f
```

The rollback drill moved 100% of traffic to the prior proxy-only version in 58.45 seconds. During rollback, `/api/platform/status` correctly returned 404 while proxied health, authenticated account and calendar reads, and exact WebSocket echo remained available.

Restoration moved 100% of traffic back to `be60f8d2-ea34-4739-82ed-0eef699f80a5` in 4.22 seconds. After restoration, the native route returned 200, the automated gate passed 16 of 16, authenticated reads and exact WebSocket echo passed, and a disposable database write/read/delete cycle completed with final state empty. Wrangler deployment status confirmed the restored version at 100% traffic.

The source changes remain local and uncommitted.

## Authenticated Operator Gate

The operator authenticated directly in the Cloudflare browser page. No password or bearer token was stored in an artifact or printed in tool output.

| Check | Result |
| --- | --- |
| `GET /accounts` | Both hosts returned 200 and identical JSON |
| `GET /calendar/unified` | Both hosts returned 200 and identical JSON |
| `GET /notes/` | Both hosts returned 200 and identical JSON |
| `GET /tasks/` | Both hosts returned 200 and identical JSON |
| Reversible date-sticky write | Edge write was visible through Render; Render write was visible through Edge |
| Write cleanup | Disposable `2099-12-31` state was deleted and confirmed empty through both hosts |
| Authenticated multipart import | Valid empty JSON upload returned identical 200 responses, imported 0, and published 0 |
| Valid WebSocket echo | Both hosts accepted the authenticated connection and returned the exact expected echo |
| OAuth invalid-state callbacks | Google and Microsoft returned identical 400 responses before provider exchange |

## Deployment Validation

| Check | Result |
| --- | --- |
| Worker unit tests | 5 passed |
| Wrangler deployment dry-run | Passed with the Render origin binding |
| Repository deployment contract | Passed |
| Platform and database contract tests | 5 passed |
| Production PostgreSQL failure behavior | Process failed closed and created no SQLite file |

## Render Local and Deployed Verification

The canonical `run.py` entrypoint started FastAPI successfully on `http://127.0.0.1:8000`. The configured Supabase hostname did not resolve from the local machine, so local development used its permitted SQLite fallback. Local schema health returned 200 with status `ok` and zero missing tables. Production remains protected by the separately passing fail-closed contract and Render environment flags.

Direct Render at `https://sherryjo-cal-app.onrender.com` returned 200 for health and schema health, with status `ok` and zero missing tables. Local and deployed schema responses were identical after excluding the expected `checked_at` timestamp.

Local FastAPI and direct Render returned matching statuses and content types for health, schema health, OpenAPI, invalid login, protected account rejection, Google invalid-state callback rejection, and invalid-token WebSocket rejection. Health, invalid login, protected account rejection, OAuth rejection, and WebSocket rejection also had identical bodies or protocol outcomes.

Local OpenAPI contains 87 paths and deployed Render contains 85. The only local-only paths are `/admin/system/cloudflare/redeploy` and `/admin/system/github/commit-push`, which are intentional uncommitted Admin changes. Deployed Render has no unexpected additional paths.

## Remaining OAuth Cutover Blocker

OAuth initiation through the Worker reaches both providers and includes signed state, but both generated callback URLs still use `sherryjo-cal-app.onrender.com`. Browser requests made directly from the Worker origin to Render are also blocked by the currently deployed CORS policy.

This does not break the tested phase-zero proxy path because the browser calls the Worker same-origin and the Worker calls Render server-to-server. It does prevent declaring the Worker hostname ready as the canonical OAuth and browser origin.

Complete the cutover in this order:

1. Register `https://sherryjo-cal-app.realty-cal.workers.dev/auth/google/callback` with Google.
2. Register `https://sherryjo-cal-app.realty-cal.workers.dev/ms/callback` with Microsoft.
3. Set Render `BASE_URL` to `https://sherryjo-cal-app.realty-cal.workers.dev`.
4. Redeploy Render.
5. Recheck OAuth initiation, direct browser CORS, and one successful provider reconnect for each provider.

The active shell did not contain a Render API credential, so the environment change was not attempted. Changing `BASE_URL` before provider callback registration could break OAuth sign-in.

## Known Platform Caveat

The `workers.dev` endpoint returns Cloudflare error 1010 for Python `urllib`'s default user agent. Browser and curl-like identities pass, and the harness uses an explicit curl-like user agent.
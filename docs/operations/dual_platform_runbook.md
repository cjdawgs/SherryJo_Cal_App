# Dual-platform deployment and failover runbook

## Environment compatibility

| Variable | Render/FastAPI | Cloudflare phase 0 | Compatibility rule |
| --- | --- | --- | --- |
| `ADMIN_SETUP_CODE` | Secret, required | Not copied | Render remains auth authority |
| `BASE_URL` | Public Cloudflare URL after cutover | N/A | Must be HTTPS; controls generated callbacks |
| `DATABASE_URL` | Supabase PostgreSQL secret | Not copied in phase 0 | Never expose a direct database credential to client code |
| `DB_TYPE` | `postgres` | N/A | Production must not auto-fallback |
| `DISABLE_SQLITE_FALLBACK` | `1` | N/A | Required to prevent ephemeral data loss |
| `GOOGLE_CLIENT_ID` | Secret/config | Not copied | Keep provider config on auth authority |
| `GOOGLE_CLIENT_SECRET` | Secret | Not copied | Never store in `wrangler.toml` |
| `GOOGLE_REDIRECT_URI` | Public callback URL | Proxied unchanged | Register both canary and production URLs before cutover |
| `JWT_ALGORITHM` | `HS256` | Not used in phase 0 | No algorithm change without coordinated token migration |
| `JWT_SECRET_KEY` | Secret, required | Not copied in phase 0 | Canonical env spelling; maps to Pydantic `jwt_secret_key` |
| `MS_CLIENT_ID` | Secret/config | Not copied | Keep provider config on auth authority |
| `MS_CLIENT_SECRET` | Secret | Not copied | Never store in `wrangler.toml` |
| `MS_REDIRECT_URI` | Public callback URL | Proxied unchanged | Register both canary and production URLs before cutover |
| `MS_TENANT_ID` | Secret/config | Not copied | Preserve current tenant behavior |
| `REQUIRE_DB_KIND` | `postgres` | N/A | Fail closed on database mismatch |
| `TOKEN_ENCRYPTION_KEY` | Secret, required | Not copied | Loss requires OAuth reconnection; rotation uses new,old keys |
| `ORIGIN_BASE_URL` | N/A | Render HTTPS origin | Must not equal the Worker hostname |
| `RENDER_DEPLOY_HOOK_URL` | Optional secret | Not copied | Enables the Render redeploy action in Admin Management |
| `CLOUDFLARE_DEPLOY_HOOK_URL` | Optional secret | Not copied | Enables the Cloudflare redeploy action; use only a trusted no-input deployment webhook |
| `CLOUDFLARE_DASHBOARD_URL` | Optional dashboard URL | N/A | Overrides the Cloudflare dashboard link shown in Admin Management |
| `ADMIN_GIT_COMMIT_SCRIPT` | Local desktop path only | Never copied | Overrides discovery of the approved PowerShell commit workflow |

Validate repository files only:

```powershell
python deployment/platform_contract.py --target repository
```

Validate the active shell without printing secret values:

```powershell
python deployment/platform_contract.py --target render
```

## Phase-zero deployment

1. Run Python tests and `node --test platform/cloudflare/test/*.test.js`.
2. Run `npx wrangler@4 deploy --dry-run`.
3. Authenticate Wrangler locally, then deploy with `npx wrangler@4 deploy`.
4. Test `https://<worker>.workers.dev/__edge/health` and proxied `/health`.
5. Test login, logout, Google and Microsoft callbacks, calendar CRUD, scheduler status, static assets, and `/ws` on the canary hostname.
6. Keep production DNS pointed at Render until the migration gate is signed off.

The `ORIGIN_BASE_URL` value is non-secret and may remain in `wrangler.toml`. Future secrets must be created with `wrangler secret put NAME`. Render secrets remain dashboard-managed (`sync: false` in the blueprint). Do not duplicate OAuth or JWT secrets into Cloudflare until Worker-native authentication is implemented and parity-tested.

## Worker-native route inventory

The following routes terminate inside the Worker and do not contact Render:

| Route | Purpose |
| --- | --- |
| `/__edge/health` | Edge proxy process health and operating mode |
| `/api/platform/status` | First Worker-native application route; confirms native routing only |

`/api/platform/status` does not prove that Render, Supabase, OAuth, or scheduled sync is healthy. All routes not listed above continue through the Render origin proxy.

After changing native routing, run the Worker unit tests, Wrangler dry-run, live endpoint check, and the complete shadow parity harness. To roll back, run `wrangler deployments list`, identify the last known-good version, and run `wrangler rollback <VERSION_ID>`. A rollback changes Worker code immediately but does not roll back bindings.

The 2026-08-01 version rollback drill moved traffic from `be60f8d2-ea34-4739-82ed-0eef699f80a5` to proxy-only version `60ba0d70-6516-445f-ae92-579620ad4a6f` in 58.45 seconds and restored the native version in 4.22 seconds. Health, authenticated Supabase-backed reads, and WebSocket echo passed in the rollback state. The native route, authenticated database write cleanup, WebSocket echo, and 16-check live gate passed after restoration.

## Database fail-closed gate

`app.db` and every other SQLite fallback are local-development facilities only. Render production must set `DB_TYPE=postgres`, `REQUIRE_DB_KIND=postgres`, and `DISABLE_SQLITE_FALLBACK=1`; an unavailable Supabase connection must stop application startup instead of creating an isolated database.

The phase-zero Cloudflare Worker has no database binding because it proxies the guarded Render origin. Future Worker-native routes must use Supabase through an approved least-privilege gateway and Hyperdrive where direct PostgreSQL connectivity is required. D1 may be evaluated later as a rebuildable read model, but it must never become an automatic fallback or an uncoordinated second source of truth.

## Admin deployment and repository controls

Admin Management detects Cloudflare requests from the edge header and otherwise identifies the active route as Render. Both platforms expose dashboard links, and each redeploy button is enabled only when its corresponding deploy-hook variable is configured.

Commit and push is intentionally a local Windows desktop action. It opens the approved `Commit_SherryJo_Cal_App.ps1` workflow in a separate PowerShell window only after the signed-in admin re-enters their current login password; it does not accept shell commands or commit messages from HTTP. Render, Cloudflare, and non-Windows runtimes report this control as unavailable. Fetch/Pull entries for the local desktop and GitHub Codespaces are visible planned stubs and do not execute repository operations yet.

## Failover: Cloudflare to Render

1. Confirm the origin directly at `https://sherryjo-cal-app.onrender.com/health`.
2. Disable the Worker route or change DNS from proxied Worker routing to the Render endpoint.
3. Verify `/health`, `/health/schema?refresh=true`, login, one calendar read, one reversible calendar write, and account scheduler health.
4. Confirm OAuth provider callbacks point to the hostname users now reach.
5. Record start/end time, trigger, affected requests, and validation evidence.

Recovery objective on free tiers is best effort because a sleeping Render instance introduces cold-start delay. A strict RTO requires a paid always-on spare or a second independently warm origin.

## Failover: Render origin degradation

Phase 0 has no independent application origin, so Cloudflare cannot mask a Render or Supabase outage. Return a controlled 502, preserve edge logs, and fail back only when Render health and schema checks pass. Do not enable SQLite fallback or redirect writes to D1 as an emergency measure.

## Database recovery

Supabase is authoritative. Before any persistence migration, capture a verified logical backup, Alembic revision, table counts by owner, and restore-test evidence. During an incident, freeze writes, drain async work, restore or forward-fix PostgreSQL, run `alembic current`, refresh `/health/schema`, and reconcile provider IDs before reopening writes.

## Required test matrix

| Layer | Required coverage |
| --- | --- |
| Unit | Domain rules, URL/header transforms, JWT claims, idempotency keys |
| Contract | Identical request/response fixtures for FastAPI and Worker adapters |
| Integration | Supabase transactions/RLS, OAuth provider mocks, D1 schema only when introduced |
| End to end | Login, OAuth, calendar CRUD/sync, notes, tasks, TV mode, assets, WebSocket |
| Deployment | Render boot/health, Worker dry-run/canary, environment contract, Alembic single head |
| Failover | Cloudflare bypass to Render, queue drain/replay, DNS and OAuth callback recovery |

No phase advances on skipped required tests, unexplained data differences, or inability to execute its rollback procedure.
# Dual-platform deployment and failover runbook

For the dependency-ordered completion checklist, owner responsibilities, pass/fail gates, and rollback steps, use [Migration completion Lego plan](migration_completion_lego_plan.md).

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
| `CALENDAR_READ_MODE` | N/A | `proxy` | Only `proxy`, `shadow`, `canary`, or `native`; invalid values fail closed to `proxy` |
| `CALENDAR_READ_CANARY_USER_IDS` | N/A | Unset | Comma-separated server-verified user IDs; required only for canary native reads |
| `JWT_PUBLIC_KEYS_JSON` | Render publishes public keys | Unset secret | Public verification keys only; never copy a private signing key to Cloudflare |
| `HYPERDRIVE_RLS_NO_CACHE` | N/A | Unbound | Future cache-disabled least-privilege PostgreSQL binding; required before non-proxy reads |
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
2. Run `npx wrangler@4 deploy --dry-run --env canary`.
3. Authenticate Wrangler locally, then deploy only the isolated canary with `npx wrangler@4 deploy --env canary`.
4. Test `https://sherryjo-calendar-edge-canary.<account-subdomain>.workers.dev/__edge/health` and proxied `/health`.
5. Test login, logout, Google and Microsoft callbacks, calendar CRUD, scheduler status, static assets, and `/ws` on the canary hostname.
6. Keep production DNS pointed at Render until the migration gate is signed off.

Wrangler variables are non-inheriting, so `ORIGIN_BASE_URL` is declared independently for the root and canary Workers. Its value is non-secret and may remain in `wrangler.toml`. Future canary secrets must be created interactively with `npx wrangler@4 secret put NAME --env canary`. Render secrets remain dashboard-managed (`sync: false` in the blueprint). Do not duplicate OAuth or JWT secrets into Cloudflare until Worker-native authentication is implemented and parity-tested.

## Manual Cloudflare release gate

`.github/workflows/cloudflare-release.yml` is manual-only and cannot run on push. It remains dormant until it is committed and its protected GitHub environments are configured. A release requires the operator to confirm that Render has deployed the selected commit, then it verifies the repository, deploys only the isolated canary, and runs unauthenticated plus reversible authenticated smoke checks. Root-Worker promotion is a separate default-off input and requires both canary smoke jobs to pass plus approval from the `cloudflare-production` environment. Production smoke checks run again after promotion.

Configure `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the `cloudflare-canary` and `cloudflare-production` GitHub environments. Configure the existing designated account's `SHERRYJO_SMOKE_EMAIL` and `SHERRYJO_SMOKE_PASSWORD` only in `cloudflare-smoke`. Require owner approval on `cloudflare-production`. Do not start this workflow until Cloudflare development is declared complete, the final commit is pushed, and Render reports that exact commit as deployed.

Before the first canary deployment, create one dedicated random edge proxy credential outside the repository. Set it as Render's `EDGE_PROXY_SECRET`, then enter the same value interactively for each Worker (Wrangler does not echo it):

```powershell
npx --yes wrangler@4 secret put EDGE_PROXY_SECRET --env canary
npx --yes wrangler@4 secret put EDGE_PROXY_SECRET
```

Set Render's `PUBLIC_BASE_URLS` to the comma-separated canary and production Worker origins, with no paths. Register both exact Google and Microsoft callback URLs with their providers. The application accepts a forwarded public host only when it is in this allowlist and the Worker presents the shared edge credential. `wrangler.toml` marks the credential as required for both environments, and `/api/platform/status` reports only the non-sensitive `edgeProxyAuthConfigured` boolean so parity smoke fails if setup is incomplete.

The authenticated harness creates one local event and one event-scoped note, verifies both targets, reads tasks/accounts/scheduler/TV state/assets, rejects a malformed upload, and checks WebSocket echo. Cleanup deletes the event and fails unless the note also disappears from both targets. It deliberately does not create tasks, retry or sync provider accounts, reconnect OAuth, generate kiosk tokens, or pair TV devices; those operations can leave persistent state or affect external providers and belong in the controlled manual canary matrix.

After the canary exists, run `Cloudflare Canary Monitor` manually once with reviewed target URLs. Then set repository variable `CLOUDFLARE_CANARY_MONITOR_ENABLED=true` to enable its hourly schedule. Optional repository variables `SHERRYJO_RENDER_MONITOR_URL` and `SHERRYJO_CLOUDFLARE_CANARY_URL` override scheduled targets. The workflow uses no secrets, tests direct Render independently from the canary, stores each report for 14 days, and fails on any parity regression. Keep GitHub Actions failure notifications enabled for the repository. Disable the repository variable before removing or renaming the canary.

## Worker-native route inventory

The following routes terminate inside the Worker and do not contact Render:

| Route | Purpose |
| --- | --- |
| `/__edge/health` | Edge proxy process health and operating mode |
| `/api/platform/status` | First Worker-native application route; confirms native routing only |
| `/calendar/unified` | Ownership-controlled read route; currently forced to `proxy` in root and canary configuration |

`/api/platform/status` does not prove that Render, Supabase, OAuth, or scheduled sync is healthy. `CALENDAR_READ_MODE=shadow` returns Render's response and records a masked comparison; `canary` requires a verified user in `CALENDAR_READ_CANARY_USER_IDS`; `native` is forbidden until the JWT, RLS, Hyperdrive, contract, and canary gates pass. To roll back calendar ownership, set `CALENDAR_READ_MODE=proxy` and redeploy the exact reviewed release.

After changing native routing, run the Worker unit tests, Wrangler dry-run, live endpoint check, and the complete shadow parity harness. To roll back, run `wrangler deployments list`, identify the last known-good version, and run `wrangler rollback <VERSION_ID>`. A rollback changes Worker code immediately but does not roll back bindings.

Worker origin failures are emitted as structured JSON containing only the event name, HTTP method, path, and error type. Query strings, authorization headers, and exception messages are intentionally excluded.

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

## Independent Render synthetic

`.github/workflows/render-hot-spare-monitor.yml` runs directly against Render and never traverses Cloudflare. It reuses the reversible authenticated smoke transaction, verifies login, calendar read/write/cleanup, notes, read-only provider status, scheduler ownership, assets, malformed upload rejection, and WebSocket echo, and retains a secret-free report for 30 days. It is default-disabled: configure the `render-monitor` GitHub environment with `SHERRYJO_SMOKE_EMAIL` and `SHERRYJO_SMOKE_PASSWORD`, then set `RENDER_HOT_SPARE_MONITOR_ENABLED=true`. A passing monitor is health evidence, not a timed failover/failback drill.

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
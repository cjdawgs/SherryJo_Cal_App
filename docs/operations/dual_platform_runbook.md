# Dual-platform deployment and failover runbook

For the dependency-ordered completion checklist, owner responsibilities, pass/fail gates, and rollback steps, use [Migration completion Lego plan](migration_completion_lego_plan.md).

## Canonical Cloudflare Worker identity

| Role | Worker name | Public URL |
| --- | --- | --- |
| Production | `sherryjo-cal-app` | `https://sherryjo-cal-app.realty-cal.workers.dev` |
| Canary | `sherryjo-cal-app-canary` | `https://sherryjo-cal-app-canary.realty-cal.workers.dev` |

`wrangler.toml` is the source of truth for both Worker names. The repository-root production command is `npm ci --prefix platform/cloudflare && npm --prefix platform/cloudflare run deploy`; the canary command is `npm ci --prefix platform/cloudflare && npm --prefix platform/cloudflare run deploy:canary`. Do not override either command with a Worker name or an additional `--env` argument.

Before retiring an old Cloudflare application:

1. Deploy and smoke-test both canonical URLs, including `/__edge/health`, `/health`, authentication callbacks, static assets, and `/ws`.
2. In the `sherryjo-cal-app` Cloudflare build settings, select repository `cjdawgs/SherryJo_Cal_App`, production branch `main`, root directory `/`, and the repository-root production command above. Configure no static asset directory.
3. Confirm Workers.dev is enabled and the displayed production URL is exactly `https://sherryjo-cal-app.realty-cal.workers.dev`.
4. Confirm `ORIGIN_BASE_URL`, JWT policy variables, and `CALENDAR_READ_MODE` match `wrangler.toml`. Set `EDGE_PROXY_SECRET` to the same secret value used by Render; never store the value in Git or copy it between dashboards through logs.
5. Move any custom domains, routes, deploy hooks, or service bindings from an old Worker to `sherryjo-cal-app`, then test them before deleting the old Worker.
6. Update GitHub repository variable `SHERRYJO_CLOUDFLARE_CANARY_URL` to the canonical canary URL. Keep `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in both protected Cloudflare environments.
7. Update Render `BASE_URL`, `PUBLIC_BASE_URLS`, OAuth callback variables, and `CLOUDFLARE_DEPLOY_HOOK_URL` for the canonical URLs. Register the exact production and canary callbacks with Google and Microsoft.
8. Disable builds on, then delete, the obsolete edge-named and generic calendar applications shown in the Cloudflare dashboard only after canonical production verification succeeds.

On another development desktop, use `git pull origin main` rather than copying individual files. Then run `npm ci --prefix platform/cloudflare` and both dry-run scripts. Local Wrangler authentication and secrets are intentionally not synchronized by Git.

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
| `CALENDAR_READ_MODE` | N/A | `native` | Only `proxy`, `shadow`, `canary`, or `native`; invalid values fail closed to `proxy` |
| `CURRENT_USER_READ_MODE` | N/A | `native` | Controls credential-free `GET /users/me` projection only |
| `DATE_STICKY_READ_MODE` | N/A | `native` | Controls both date-sticky GET routes |
| `DATE_STICKY_WRITE_MODE` | N/A | `native` | Controls replay-safe calendar and TV date-sticky PUT routes |
| `EVENT_WRITE_MODE` | N/A | `native` | Controls replay-safe local event create/update/delete routes |
| `LEGACY_EVENT_READ_MODE` | N/A | `native` | Controls smoke-compatible `GET /events/` |
| `NOTE_READ_MODE` | N/A | `native` | Controls date-filtered `GET /notes/` |
| `NOTE_WRITE_MODE` | N/A | `proxy` | Remains proxied until all callers supply the idempotency contract |
| `TAG_COLOR_READ_MODE` | N/A | `native` | Controls `GET /calendar/tag-colors` |
| `TAG_COLOR_WRITE_MODE` | N/A | `native` | Controls replay-safe tag-color PUT |
| `TASK_READ_MODE` | N/A | `native` | Controls `GET /tasks/` |
| `TASK_WRITE_MODE` | N/A | `proxy` | Remains proxied until all callers supply the idempotency contract |
| `TV_VERSION_READ_MODE` | N/A | `native` | Controls `GET /tv/version` and requires matching `TV_APP_VERSION` |
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

1. Run `npm ci --prefix platform/cloudflare`, Python tests, and `node --test platform/cloudflare/test/*.test.js`.
2. From the repository root, run `npm --prefix platform/cloudflare run deploy:dry-run:canary`.
3. Authenticate Wrangler locally, then deploy only the isolated canary with `npm --prefix platform/cloudflare run deploy:canary`.
4. Test `https://sherryjo-cal-app-canary.realty-cal.workers.dev/__edge/health` and proxied `/health`.
5. Test login, logout, Google and Microsoft callbacks, calendar CRUD, scheduler status, static assets, and `/ws` on the canary hostname.
6. Keep production DNS pointed at Render until the migration gate is signed off.

For Cloudflare Git Builds with root directory `/`, use `npm ci --prefix platform/cloudflare && npm --prefix platform/cloudflare run deploy` as the deploy command. If the dashboard root directory is `platform/cloudflare`, use `npm ci && npm run deploy`. Do not use an assets deploy preset; this project is a Worker proxy and intentionally has no `public/` or `dist/` directory.

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

The following routes have Worker-native implementations. Production uses the modes recorded below; canary reads remain `shadow` and canary writes remain `proxy`:

| Route | Purpose |
| --- | --- |
| `/__edge/health` | Edge proxy process health and operating mode |
| `/api/platform/status` | First Worker-native application route; confirms native routing only |
| `/calendar/unified` | Production-native ownership-controlled calendar read |
| `/calendar/date-sticky[/{date}]` | Production-native user-owned date-sticky reads and replay-safe writes |
| `/calendar/tag-colors` | Production-native user-owned tag-color reads and replay-safe writes |
| `/events/` | Legacy user-owned event and embedded-note read used by smoke validation |
| `/notes/` | Production-native date-filtered read; standalone writes remain proxied |
| `/tasks/` | Production-native task-list read; standalone writes remain proxied |
| `/tv/version` | Authenticated deployment-version read; requires explicit matching version configuration before non-proxy use |
| `/users/me` | Credential-free current-user identity projection |

`/api/platform/status` does not prove that Render, Supabase, OAuth, or scheduled sync is healthy. Each read-mode variable supports `proxy`, `shadow`, `canary`, and `native`; shadow mode returns Render's response and records only masked status/match metadata. Canary mode requires a verified user in `CALENDAR_READ_CANARY_USER_IDS`. Native mode is forbidden until the JWT, RLS, Hyperdrive, contract, and canary gates pass. To roll back route ownership, set its read mode to `proxy` and redeploy the exact reviewed release.

`/accounts` and `/accounts/sync-status` remain on Render because their responses include credential-decryption health, provider remediation, and scheduler state. `/tv/state` remains with its PATCH route because both use process-local shared state. `/tv/events` remains with that state owner because it also performs recurrence expansion, account legend projection, conditional ETag handling, and stale-snapshot fallback. These routes move with their owning OAuth, scheduler, and TV-state subsystems rather than as isolated database reads.

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

Cloudflare now executes production database-local reads plus event, date-sticky, and tag-color writes independently. Provider, OAuth, scheduler, import, administrative, WebSocket, and TV-state-dependent routes still require Render. During Render degradation, native routes continue operating while proxied routes return a controlled 502. Preserve edge logs and restore proxy availability only after Render health and schema checks pass. Do not enable SQLite fallback or redirect writes to D1 as an emergency measure.

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
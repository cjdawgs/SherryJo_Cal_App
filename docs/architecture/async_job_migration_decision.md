# Async job migration inventory and decision

Status: Cloudflare Cron implementation complete in the repository; production cutover requires the ordered migration and deployment gate below. Render remains the active owner until that gate is executed.

## Current ownership

The deployed baseline owns scheduling in one process-local Render APScheduler instance created by `app/services/sync_scheduler.py`. The pending release moves Google, Microsoft, and Apple event polling plus scheduler maintenance to a Worker-native five-minute Cron Trigger using Hyperdrive and Supabase PostgreSQL, without contacting Render. A bounded security-definer claim function selects due accounts, while every account mutation and ledger write runs under transaction-local user identity and RLS. Queue and Durable Object ownership remain disabled.

| Job | Trigger and upper bound | Inputs and writes | External side effects | Retry and overlap behavior | Migration readiness |
| --- | --- | --- | --- | --- | --- |
| Google/Microsoft event sync | Cloudflare Cron every 5 minutes; bounded claim batch, default 10 accounts | Claims due OAuth accounts, refreshes rotating tokens, consumes Google sync tokens and Microsoft delta links, then creates, updates, or removes provider rows under user RLS | Google Calendar API and Microsoft Graph directly from the Worker | Stable per-account operation keys, row claims, advisory locks, terminal-key exclusion, three-attempt dead-letter, bounded pagination, and independent account failure handling | **Implemented, deployment pending.** Provider fixtures, replay tests, Worker route regression tests, and Wrangler dry-runs pass. |
| Apple event sync | Same Cloudflare Cron claim path; account cadence still applies | Runs bounded CalDAV time-range queries, parses iCalendar, expands recurrences only inside the configured range, and atomically replaces stale provider rows | Apple CalDAV directly from the Worker using the stored app password | Strict failure behavior prevents provider errors from becoming destructive empty syncs; occurrence IDs are stable; page, calendar, event, and recurrence bounds apply | **Implemented, deployment pending.** CalDAV discovery, recurrence, range, and authorization fixtures pass. |
| TV diagnostics prune | Cloudflare maintenance function invoked by Cron | Deletes `tv_diag_log` rows older than `TV_DIAG_RETENTION_DAYS`, default 14 days | None | Timestamp predicate is idempotent and retention is bounded from 1 to 365 days | **Implemented, deployment pending.** The Worker receives only EXECUTE permission on the security-definer function. |
| Sync-efficiency rollup | Cloudflare maintenance function invoked by Cron | Upserts one daily row from durable successful `worker_scheduled_sync` ledger results | None | Unique daily key and deterministic ledger-derived counts survive process restarts | **Implemented, deployment pending.** Render process-memory cache metrics are intentionally zero in the native rollup. |

Repository evidence does not establish observed daily provider-operation or diagnostic-row volume. The scheduler health and rollup endpoints provide current counters, but a migration cost comparison must use a dated production capture rather than treating heartbeat frequency as billable work volume.

## Replay and idempotency status

Event sync has result-level deduplication plus durable operation-ledger tracking. Current scheduler operations now use immutable operation IDs, stable deterministic operation keys, attempt history, and durable terminal states (`succeeded`, `retry_pending`, `dead_letter`). Before Queues can own provider work, consumer-level delivery/replay semantics must still be proven for duplicate delivery, timeout-after-provider-success, poison messages, and dead-letter recovery.

No migration may run Render APScheduler and Cloudflare ownership for the same operation simultaneously. A fail-closed exclusive-owner setting is now in place via `SYNC_SCHEDULER_OWNER` (default `render`) and should be preserved for canary and rollback until distributed ownership is formally replaced.

## Current recommendation

All provider polling and scheduler maintenance now use the **Cron only** design. Queue delivery remains deferred because the bounded account volume does not justify another delivery layer.

## Ordered production cutover

1. Apply Alembic revisions through `am993g33zzz77` while Render remains the scheduler owner. These add scheduler claims, native authentication/account access, atomic TV pairing, persistent TV state and diagnostics, one-time WebSocket tickets, and app-admin RLS policies without changing runtime ownership.
2. Deploy the Worker code with repository default `SCHEDULED_SYNC_ENABLED=false` and verify native HTTP routes, OAuth, Hyperdrive, and the migration contract.
3. Change Render to `SYNC_SCHEDULER_OWNER=cloudflare`, an empty `SYNC_RENDER_PROVIDER_ALLOWLIST`, and `SYNC_MAINTENANCE_SCHEDULER_OWNER=cloudflare`. Render will start no scheduler jobs after its restart.
4. Immediately change the production Worker to `SCHEDULED_SYNC_ENABLED=true` and deploy it. Verify one Cron cycle creates `worker_scheduled_sync` ledger rows, advances Google, Microsoft, and Apple account markers, prunes diagnostics, and updates the daily rollup. Repository defaults intentionally keep Render on and Worker Cron execution off so an ordinary auto-deploy cannot accidentally create duplicate ownership or a sync gap.
5. Keep canary `SCHEDULED_SYNC_ENABLED=false`; it shares production data and must never become a second scheduler owner.
6. Roll back by disabling Worker scheduled sync first, waiting for active claim leases to expire (maximum 240 seconds by default), then restoring Render ownership.

## Full Render severance switch

`ORIGIN_FALLBACK_MODE` is the reversible application-level switch:

- `proxy` preserves the current stable deployment and sends routes without native Worker implementations to Render.
- `severed` guarantees the Worker makes no Render origin request. Native routes continue operating; an unmigrated route returns a structured `503 worker_route_not_migrated` response.
- Invalid values fail closed as `severed` so a typo cannot silently restore an origin dependency.

Production remains `proxy` in this release. The main calendar, login, accounts, and admin HTML shells plus `/static/*` assets are Worker assets. Password login/registration are implemented with compatible Argon2 hashes and RS256 sessions but retain the safe `AUTH_MODE=proxy` deployment default until the native-auth migration is applied and the mode is deliberately enabled. Account listing, sync status/rollups, settings, primary selection, enable/disable, color, disconnect, Apple test/connect, and immediate retry/refresh are implemented under owner RLS; `ACCOUNT_READ_MODE` and `ACCOUNT_WRITE_MODE` likewise remain `proxy` until migrations `ag987a77ttt11` and `ah988b88uuu22` are applied.

TV code generation, one-time manual redemption, same-address auto-pair, dashboard/kiosk assets, persistent RS256 TV sessions, database-backed state, event aggregation, and bounded diagnostics are implemented natively. Pairing codes are stored only as SHA-256 hashes and consumed atomically; TV state remains owner-scoped and never injects today's date. Calendar file import and Google/Microsoft publish are native, while Apple publish remains explicitly unsupported at parity with FastAPI. WebSocket tickets are database-backed, short-lived, and atomically single-use; the socket preserves the existing echo-only contract and therefore does not require a Durable Object.

Admin data APIs are implemented behind an app-admin RLS predicate derived from transaction-local JWT identity. Managed-table inspection redacts credentials, and the Worker cannot mutate `TOKEN_ENCRYPTION_KEY` through HTTP because deployed secrets remain a Cloudflare control-plane operation. `TV_PAIRING_MODE`, `TV_STATE_MODE`, `TV_EVENTS_MODE`, `TV_DIAGNOSTICS_MODE`, `CALENDAR_IMPORT_MODE`, `CALENDAR_PUBLISH_MODE`, `CALENDAR_SYNC_MODE`, `WEBSOCKET_MODE`, and `ADMIN_API_MODE` remain `proxy` until migrations through `am993g33zzz77` are applied and each grouped route is exercised. Worker tests prove the severance switch and native browser routes make zero origin calls; production should change `ORIGIN_FALLBACK_MODE` to `severed` only after all route modes and native scheduler ownership pass the ordered gate above.

Decision support artifact: [artifacts/capacity/async-capacity-20260805T152723Z.md](../../artifacts/capacity/async-capacity-20260805T152723Z.md) summarizes the latest ledger-based capacity evidence and records the current recommendation for the migration gate.

## Required evidence before approval

1. Dated production volume for scheduler wakeups, due users/accounts, provider reads/writes, failures, diagnostic rows pruned, and rollup writes.
2. End-to-end duplicate-delivery, timeout-after-provider-success, poison-message, dead-letter, and replay tests for any queue-backed consumer.
3. Cost comparison against current Render execution and current Cloudflare limits.
4. Canary proof that only one scheduler owns each operation and rollback restores Render ownership without duplicates.
5. Owner-approved decision record: `defer`, `Cron only`, or `Queues + Cron`.

Focused tests now prove duplicate-key replay behavior, retry resumption, dead-letter transitions, dead-letter skip guards (including repeated-cycle skip), idempotent diagnostic pruning, and daily rollup upsert behavior.
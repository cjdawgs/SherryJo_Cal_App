# Async job migration inventory and decision

Status: In progress. Render remains the active scheduler owner while async migration evidence and decision gates are completed.

## Current ownership

Render owns one process-local APScheduler instance created by `app/services/sync_scheduler.py` and started from the FastAPI startup hook. Supabase PostgreSQL remains authoritative. Cloudflare Queue, Cron Trigger, and Durable Object ownership are not enabled for scheduler jobs. A durable PostgreSQL async-operation ledger now exists and is integrated with all three current APScheduler jobs.

| Job | Trigger and upper bound | Inputs and writes | External side effects | Retry and overlap behavior | Migration readiness |
| --- | --- | --- | --- | --- | --- |
| Event sync | Interval heartbeat, default every 5 minutes; at most 288 scheduler wakeups per day before configuration changes | Reads sync-enabled accounts and per-account cadence/range; creates, updates, deletes, and deduplicates authoritative events; updates account sync markers | Google Calendar, Microsoft Graph, and Apple/CalDAV operations through `CalendarService.sync_all` | Deterministic operation key + durable ledger lifecycle are implemented. Dead-letter operation keys are skipped. Failures transition to `retry_pending` and then `dead_letter` at max attempts. Adaptive due state and efficiency counters are still process-local. | **In progress.** Ledger-ready foundation exists; queue delivery/replay semantics and observed-volume evidence remain open. |
| TV diagnostics prune | 24-hour interval; one intended run per day | Deletes `tv_diag_log` rows older than `TV_DIAG_RETENTION_DAYS`, default 14 days | None | Deterministic operation key + durable ledger lifecycle are implemented. Dead-letter operation keys are skipped. Timestamp predicate remains idempotent. | **In progress.** Cron-candidate path is technically prepared; production ownership/canary evidence remains open. |
| Sync-efficiency rollup | Daily at 00:05 UTC; one intended run per day | Upserts one `sync_efficiency_daily_rollups` row per UTC date | None | Deterministic operation key + durable ledger lifecycle are implemented. Dead-letter operation keys are skipped. Daily unique key remains idempotent, but source counters and Google cache metrics are process-local and reset on restart. | **In progress.** Ledger and idempotent upsert are in place; durable metric derivation and migration decision remain open. |

Repository evidence does not establish observed daily provider-operation or diagnostic-row volume. The scheduler health and rollup endpoints provide current counters, but a migration cost comparison must use a dated production capture rather than treating heartbeat frequency as billable work volume.

## Replay and idempotency status

Event sync has result-level deduplication plus durable operation-ledger tracking. Current scheduler operations now use immutable operation IDs, stable deterministic operation keys, attempt history, and durable terminal states (`succeeded`, `retry_pending`, `dead_letter`). Before Queues can own provider work, consumer-level delivery/replay semantics must still be proven for duplicate delivery, timeout-after-provider-success, poison messages, and dead-letter recovery.

No migration may run Render APScheduler and Cloudflare ownership for the same operation simultaneously. A fail-closed exclusive-owner setting is now in place via `SYNC_SCHEDULER_OWNER` (default `render`) and should be preserved for canary and rollback until distributed ownership is formally replaced.

## Current recommendation

Current recommendation remains **defer** for Queue/Cron execution ownership until observed production volume, cost evidence, and end-to-end replay semantics are complete. Event sync, TV diagnostics pruning, and efficiency rollup remain Render-owned. No Cloudflare scheduler binding is configured, preventing duplicate provider execution during native route cutover.

## Required evidence before approval

1. Dated production volume for scheduler wakeups, due users/accounts, provider reads/writes, failures, diagnostic rows pruned, and rollup writes.
2. End-to-end duplicate-delivery, timeout-after-provider-success, poison-message, dead-letter, and replay tests for any queue-backed consumer.
3. Cost comparison against current Render execution and current Cloudflare limits.
4. Canary proof that only one scheduler owns each operation and rollback restores Render ownership without duplicates.
5. Owner-approved decision record: `defer`, `Cron only`, or `Queues + Cron`.

Focused tests now prove duplicate-key replay behavior, retry resumption, dead-letter transitions, dead-letter skip guards (including repeated-cycle skip), idempotent diagnostic pruning, and daily rollup upsert behavior.
# Async job migration inventory and decision

Status: Repository inventory complete; owner decision pending.

## Current ownership

Render owns one process-local APScheduler instance created by `app/services/sync_scheduler.py` and started from the FastAPI startup hook. Supabase PostgreSQL remains authoritative. No Cloudflare Queue, Cron Trigger, Durable Object, or async-operation ledger exists.

| Job | Trigger and upper bound | Inputs and writes | External side effects | Retry and overlap behavior | Migration readiness |
| --- | --- | --- | --- | --- | --- |
| Event sync | Interval heartbeat, default every 5 minutes; at most 288 scheduler wakeups per day before configuration changes | Reads sync-enabled accounts and per-account cadence/range; creates, updates, deletes, and deduplicates authoritative events; updates account sync markers | Google Calendar, Microsoft Graph, and Apple/CalDAV operations through `CalendarService.sync_all` | User failures are logged and the loop continues; no durable retry, dead-letter state, distributed lease, or immutable operation ID; adaptive due state and efficiency counters are process-local | **Defer.** Not replay-safe enough for at-least-once Queue delivery or dual scheduler ownership |
| TV diagnostics prune | 24-hour interval; one intended run per day | Deletes `tv_diag_log` rows older than `TV_DIAG_RETENTION_DAYS`, default 14 days | None | Timestamp predicate is idempotent; failures roll back and wait for the next interval; no distributed ownership | **Cron candidate only.** First add an exclusive-owner switch or database lease and prove Render and Cloudflare cannot run it concurrently |
| Sync-efficiency rollup | Daily at 00:05 UTC; one intended run per day | Upserts one `sync_efficiency_daily_rollups` row per UTC date | None | Daily unique key makes the write idempotent, but source counters and Google cache metrics are process-local and reset on restart | **Defer or redesign.** Derive metrics from durable records before moving execution |

Repository evidence does not establish observed daily provider-operation or diagnostic-row volume. The scheduler health and rollup endpoints provide current counters, but a migration cost comparison must use a dated production capture rather than treating heartbeat frequency as billable work volume.

## Replay and idempotency gaps

Event sync currently has result-level event deduplication, but that is not an operation ledger. Before Queues can own provider work, each dispatch needs an immutable operation ID, a stable idempotency key scoped to user/account/window/action, durable states (`pending`, `running`, `succeeded`, `failed`, `dead-letter`), attempt history, and a uniqueness constraint. Provider writes must record enough state to distinguish failure before an external write from failure after external success but before local acknowledgement.

No migration may run Render APScheduler and Cloudflare ownership for the same operation simultaneously. A database lease or explicit exclusive-owner setting must fail closed during canary and rollback.

## Current recommendation

Choose **defer** for Queues and Cron until the operation ledger and replay tests exist. If an earlier Cron proof is desired, use only TV diagnostics pruning after adding exclusive ownership. Keep event sync and efficiency rollup on Render. This recommendation adds no Cloudflare binding and changes no runtime ownership.

## Required evidence before approval

1. Dated production volume for scheduler wakeups, due users/accounts, provider reads/writes, failures, diagnostic rows pruned, and rollup writes.
2. Durable operation-ledger migration and lifecycle tests.
3. Duplicate-delivery, timeout-after-provider-success, poison-message, dead-letter, and replay tests.
4. Cost comparison against current Render execution and current Cloudflare limits.
5. Canary proof that only one scheduler owns each operation and rollback restores Render ownership without duplicates.

Focused tests now prove diagnostic pruning preserves current rows and that repeated daily rollup execution updates one row instead of creating duplicates.
# Logging and usage controls

Free-tier hosting bills by log volume, request count and stored rows. Every
knob below exists because one of those three was growing on a timer rather than
in response to a user.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `LOG_LEVEL` | `WARNING` on Render, `INFO` locally | Root log level. Set to `DEBUG` to get the old tracing back without a code change. |
| `SYNC_CONSOLE_VERBOSE` | `0` | Per-user sync result lines from the background scheduler. |
| `TV_DIAG_PERSIST` | `1` | Set to `0` to stop writing `tv_diag_log` rows entirely (the in-memory buffer and the admin panel keep working for the current process). |
| `TV_DIAG_ROUTINE_PERSIST_MINUTES` | `60` | How often a routine event (`heartbeat`, `poll`, `tick`) from one device may be written to the table. |
| `TV_DIAG_RETENTION_DAYS` | `14` | Rows older than this are deleted by the daily prune job. |

## What changed

- **Central logging.** `app/logging_config.py` installs `basicConfig`, third-party
  muting and the access-log filter once at startup. All 171 `print()` calls
  became module-logger calls with lazy `%s` formatting, so `LOG_LEVEL` actually
  governs output. Previously the reverse was true: `print()` always wrote, while
  every `logger.info()` was discarded because nothing configured the root logger.
- **Access log.** Successful requests to `/health`, `/tv/diag` and `/static/*`
  are dropped. Any 4xx/5xx is always kept.
- **Count-only queries.** `/calendar/unified` and `/calendar/sync-all` ran
  `SELECT count(*) FROM events` solely to feed a log line. Removed.
- **TV telemetry.** The dashboard batches beacons (one request per 5 minutes
  instead of one per event, high-signal events still flush immediately), and the
  heartbeat moved from 60 s to 15 min. Routine events are persisted at most once
  per device per hour; a separate authenticated `device_presence` check-in is
  persisted at most once every 15 minutes after a successful calendar response.
- **TV liveness.** Calendar payloads remain on a 10-minute poll. An empty startup
  gets one retry after 5 seconds, and a visible paired TV sends one small
  `/__edge/health` pulse every 5 minutes. The pulse is answered entirely by the
  Cloudflare Worker: it does not wake Render, query the database, write a
  diagnostic row, or create an application access log. That is 288 inexpensive
  edge requests per continuously visible TV per day. Device status in Admin is
  based on authenticated calendar-response check-ins; stale diagnostics are
  shown as unknown rather than treated as proof that a TV is offline. The
  Connection Gap & Recovery Log compares persisted device check-ins and reports
  recovered or ongoing gaps; it can correlate delivered timeout/auth events but
  cannot establish a precise outage start or cause while the TV is disconnected.
- **Local sleep guard.** A 30-second browser-only watchdog checks the screen wake
  lock, animation loop, synthetic-input timer, media stream and Web Audio layer.
  It repairs inactive layers before the Fire OS inactivity window is reached.
  The watchdog makes no network request; repair telemetry is capped at one
  diagnostic event per hour per running TV session.
- **Persistent TV pairing.** A transient `401` records one repair-risk event but
  no longer deletes the long-lived TV token. Pairing storage is cleared only by
  an explicit logout/unpair action, and a later successful authenticated request
  restores the paired status automatically.
- **Retention.** A daily scheduler job prunes `tv_diag_log`; it was the only
  table that grew without user action and nothing deleted from it.
- **Sync scheduler.** One aggregated line per cycle instead of one per user, and
  the wakeup selects only users that own a sync-enabled account.
- **Four-hour provider cadence.** Automatic sync uses UTC slots beginning at
  00:00, 04:00, 08:00, 12:00, 16:00 and 20:00, with a 240-minute minimum for
  Google, Microsoft and Apple. A one-minute tolerance prevents a few seconds
  of startup jitter from missing the next slot; a delayed or manually refreshed
  account may instead run on a later heartbeat. Configured intervals longer
  than four hours are respected and run at the first qualifying slot. New
  accounts and retries can run at a heartbeat outside a slot boundary.
  The Worker retains its five-minute claim heartbeat so its bounded batches
  drain over multiple invocations; that heartbeat does not itself imply a
  provider sync. Render processes each due account independently. The former
  per-user adaptive backoff no longer overrides account schedules. Manual
  account refresh remains immediate and targets the selected account.
  The Cloudflare release requires the `ALEMBIC_DATABASE_URL` Actions secret:
  the migration must succeed before the Worker is deployed. The release
  stops rather than deploying with an old claim function if it is missing.
  The migration process also receives non-secret OAuth and JWT placeholders
  because application settings are imported during Alembic startup; these
  placeholders are not deployed or used to authenticate users.
  Release verification tests both a fresh database and an older database with
  pre-existing TV refresh columns and policy before applying migrations.
- **Range changes.** Changing an account's range clears its provider cursors
  and assigns a new range generation. An in-flight sync cannot write a cursor
  from the previous generation; the next scheduled or manual sync starts a
  new baseline. Both schedulers honor configured ranges up to 3,650 days
  on either side of the current time; larger windows can be costly.
- **Cloudflare scheduled sync.** For events with distinct provider identifiers,
  the Worker reads existing rows and writes event updates and inserts in batches
  under the same owner-scoped transaction. This reduces Hyperdrive statements
  even when a provider returns a large full sync. Duplicate identifiers retain
  sequential processing. Google results in the `scheduled_calendar_sync` log
  include `syncDiagnostics` counts for full and incremental calendars and
  missing next sync tokens; they never contain token values. A high full-sync
  count or missing token count warrants investigation and does not by itself
  establish why Google returned that result. An expired Google cursor is not
  retained if the replacement response has no cursor. Cursor updates support
  PostgreSQL `json` and `jsonb` columns. An explicit account retry starts a new
  operation even if a previous scheduled operation was dead-lettered; automatic
  retries remain bounded. After deploying a sync fix, retry an affected account
  once and confirm it returns to OK; reconnect only when authorization requires
  it. A reconnect also updates the account's success timestamp, so that
  timestamp alone does not prove a provider sync completed.
- **Full-sync reconciliation.** Both runtimes limit stale-event deletion to
  the fetched date window. FastAPI reconciles only accounts with successful
  full responses, while the Worker skips Google stale reconciliation when
  the account response combines full and incremental calendars or has no
  eligible calendars. Explicit cancellations still apply outside the window.
- **FastAPI Google sync.** Calendar discovery follows all pages; discovery or
  event-fetch failures are reported as account errors rather than successful
  empty snapshots. An expired cursor without a replacement is removed so the
  next attempt starts with a full baseline.
- **Browser console.** `console_quiet.js` no-ops `log`/`debug`/`info` unless
  `localStorage.debug === '1'`; `warn` and `error` are untouched.

## Turning diagnostics back on

On the device's console:

```js
localStorage.debug = '1'; location.reload();
```

On the server, set `LOG_LEVEL=DEBUG` (and `SYNC_CONSOLE_VERBOSE=1` for sync
detail) in Render, then redeploy or restart the service.

## Checking the table size

```sql
SELECT count(*) AS rows,
       pg_size_pretty(pg_total_relation_size('public.tv_diag_log')) AS size,
       min(ts_server) AS oldest,
       max(ts_server) AS newest
FROM public.tv_diag_log;
```

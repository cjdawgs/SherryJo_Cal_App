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
  heartbeat moved from 60 s to 15 min. Server-side, routine events are recorded
  in memory but reach the table at most once per device per hour.
- **Retention.** A daily scheduler job prunes `tv_diag_log`; it was the only
  table that grew without user action and nothing deleted from it.
- **Sync scheduler.** One aggregated line per cycle instead of one per user, and
  the wakeup selects only users that own a sync-enabled account.
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

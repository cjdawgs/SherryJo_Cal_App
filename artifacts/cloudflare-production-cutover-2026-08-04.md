# Cloudflare production cutover evidence

Date: 2026-08-04

## Production ownership

Worker version `3eb1dfd5-bff3-4cff-b9dd-037a37971e98` was deployed with native calendar, current-user, date-sticky, legacy-event, note, tag-color, task, and TV-version reads. Event, date-sticky, and tag-color writes are native. Standalone note/task writes and provider-bound, OAuth, scheduler, import, administrative, WebSocket, and TV-state-dependent routes remain proxied.

The no-cache production status endpoint returned every intended mode. The pre-cutover version `13e953c3-5424-4cdc-8d86-81c14540b4df` remains retained as a proxy-default version rollback target; unconfigured route modes fail closed to `proxy`.

## Database and release gates

- Supabase Alembic revision: `aa980u11mmm44`.
- Replay receipts have RLS enabled, no `anon`/`authenticated` table grants, and application-owned default ACLs do not regrant public table, sequence, or function access.
- Python suite: 532 passed, 29 optional live-integration tests skipped.
- Worker suite: 69 passed.
- Note/task RLS migration tests: passed.
- Scheduler suite: 30 passed.
- WebSocket ticket suite: 4 passed.
- Production and canary Wrangler dry-runs: passed.
- Restricted Worker-role note/task proof: exact replay, changed-request conflict, one row, and one receipt per operation.
- Temporary proof users, application rows, tickets, and replay receipts were removed.

## Authenticated production smoke

The reversible Render/production-Worker smoke passed 23 checks with cleanup. It covered cross-platform event create/update/read, note visibility, tasks, account and scheduler status, TV state/version, static assets, invalid import rejection, and WebSocket echo through both origins.

## Render hot spare

Direct Render health returned HTTP 200 in 0.204 seconds. Refreshed schema health returned HTTP 200 in 0.485 seconds. The direct-Render synthetic passed 23 checks with cleanup, including login, CRUD, scheduler ownership, assets, malformed import rejection, and WebSocket echo.

Render recovery remains best effort on the free plan because a sleeping instance has no strict cold-start RTO. The direct monitor workflow is available for daily validation after its protected environment credentials and enablement variable are configured.

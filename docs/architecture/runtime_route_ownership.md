# Runtime Route Ownership

This document defines the migration boundary between Cloudflare Worker-native routes and the Render hot-spare/origin.

## Worker-native capable

These routes have owner-scoped PostgreSQL RLS, strict RS256 authentication, replay receipts, conflict handling, and canary/native mode gates:

- Calendar reads and local event CRUD
- Calendar and TV date-sticky upserts
- Tag-color settings reads and writes
- Current-user, task, note, and legacy-event reads
- Standalone note upsert and task creation
- TV application version

Production reads are `native`. Calendar event, date-sticky, and tag-color writes are also `native` because their shipped clients provide durable idempotency keys. Standalone note and task writes remain `proxy`; no shipped client calls them with the required idempotency contract. Canary reads remain `shadow`, and canary writes remain `proxy` for rollback comparison.

## Render-owned until dedicated migration

These routes are intentionally proxied because they depend on provider credentials, long-running orchestration, file parsing, administrative authority, or in-memory TV state:

- Google, Microsoft, and Apple OAuth initiation/callbacks and account management
- Provider sync, publish, retry, refresh, and deduplication
- Calendar file import
- Scheduler heartbeat, token refresh, maintenance pruning, and daily rollups
- Administrative user/provider/maintenance operations
- TV event creation when it falls back to Render's in-memory `tv_state_store`
- WebSocket ticket issuance and origin-side socket handling

A proxied route in this section is not an accidental migration gap. It moves only when its owning subsystem has an independent Cloudflare implementation and rollback proof.

## Safety rules

- Invalid route-mode values fail closed to `proxy`.
- Native and canary writes require an `Idempotency-Key`.
- Canary writes require a verified user ID in `CALENDAR_READ_CANARY_USER_IDS`.
- Hyperdrive uses the cache-disabled, least-privilege `worker_calendar_reader` role.
- Render remains the rollback target after production cutover; direct health, schema, authenticated CRUD, scheduler, asset, import-rejection, and WebSocket checks are monitored independently.

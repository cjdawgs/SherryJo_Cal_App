# Cloudflare optional bindings decision

Status: Engineering recommendation complete; owner approval pending.

No KV namespace, R2 bucket, or Durable Object binding is configured. Supabase PostgreSQL remains authoritative and Render remains the application/WebSocket origin.

## Workers KV: defer

No measured read-heavy cache bottleneck justifies KV. Current route configuration is small, deployment-scoped, and suitable for Wrangler variables. Calendar events, notes, tasks, account state, authorization decisions, WebSocket tickets, and OAuth state require transactional or immediate consistency and must never use KV as truth. Cloudflare documents KV reads as eventually consistent, with stale and negative lookups potentially remaining visible after writes.

- **Data classification:** Only future public or disposable derived configuration could qualify. No credentials, tenant authorization, calendar data, or security decisions.
- **Consistency/invalidation:** A future use case must tolerate stale reads and define versioned keys, TTL, invalidation, and rebuild behavior.
- **Deletion/backup:** Deletion is best-effort cache invalidation; no backup is required because the source must remain authoritative elsewhere.
- **Observability/cost:** Current projected requests, storage, reads, and writes are zero. Measure cache hit rate and current origin cost before proposing a namespace.
- **Fallback:** Remove the binding and read from the existing authoritative path.
- **Revisit trigger:** A measured, read-heavy, non-sensitive response has material origin latency or request cost and can tolerate documented staleness.

## R2: not applicable

The application does not persist user-uploaded binary objects. Calendar import uploads are parsed request payloads, not retained files; static assets are repository artifacts served by FastAPI. Adding object storage would create lifecycle, access-control, deletion, and backup obligations without a product requirement.

- **Data classification:** No current data qualifies. OAuth exports, database backups, logs, and calendar/auth records are explicitly excluded from an ad hoc R2 rollout.
- **Consistency/retention:** Not defined because no retained-object requirement exists.
- **Deletion/backup:** Not defined; any future binary feature must specify user deletion, retention, legal recovery, and backup policy first.
- **Observability/cost:** Current projected objects, storage, operations, and egress are zero.
- **Fallback:** Continue parsing imports in memory and serving versioned repository assets through the existing path.
- **Revisit trigger:** A real product feature requires durable user binary storage with an approved retention and access policy.

## Durable Objects: defer

The current WebSocket endpoint authenticates a one-time ticket and echoes each client's message to that same connection. It has no room membership, cross-client broadcast, presence, shared lock, or per-user coordination state. The Worker can proxy this connection to Render; adding a Durable Object now would duplicate authentication and introduce a new state boundary without solving measured behavior.

Cloudflare recommends Durable Objects with WebSocket hibernation when one object must coordinate multiple persistent clients. That architecture should be considered only after a real coordination requirement and connection metrics exist.

- **Data classification:** A future object may hold short-lived per-user connection metadata, never OAuth credentials or authoritative calendar state.
- **Partitioning/authorization:** Partition by an internal non-guessable user or tenant identity. Validate the authenticated identity before object lookup and on every message/RPC boundary.
- **Persistence/deletion:** Durable state must be minimal, reconstructable, and deleted when the owning account is removed. Connection attachments cannot be the only copy of state needed after disconnect.
- **Observability/cost:** Current projected object requests, duration, and storage are zero. Capture concurrent connections, reconnects, message rate, and required fan-out before sizing.
- **Fallback:** Remove route ownership and proxy `/ws` to Render.
- **Revisit trigger:** The product needs cross-instance fan-out, presence, shared per-user coordination, or measured long-lived connection behavior that Render cannot meet.

## Recommendation

Approve `KV: deferred`, `R2: not applicable`, and `Durable Objects: deferred`. These decisions deliberately add no products merely to satisfy a migration checklist. Each can be reopened independently when its revisit trigger is met.
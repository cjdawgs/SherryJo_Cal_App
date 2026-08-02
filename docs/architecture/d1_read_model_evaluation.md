# D1 read-model evaluation

Status: Schema inventory and projection design complete; implementation and owner decision pending.

## Decision boundary

D1 is not a replacement for Supabase PostgreSQL. It may be evaluated only as a disposable, one-way, rebuildable projection for the bounded unified-calendar read contract. Supabase remains authoritative, and D1 data must never flow back automatically or make authentication, authorization, OAuth, sync, ticket, or write-conflict decisions.

Python SQLAlchemy and Alembic code cannot run unchanged inside the JavaScript Worker. A future adapter must use the D1 Worker binding API and pass the same platform-neutral fixtures as FastAPI.

## PostgreSQL compatibility inventory

| Current behavior | PostgreSQL dependency | D1 projection rule |
| --- | --- | --- |
| Timezone-aware event, account, ticket, and audit timestamps | `TIMESTAMPTZ` through `DateTime(timezone=True)` | Store canonical UTC ISO-8601 `TEXT`; reject non-canonical input during projection and parse explicitly in the adapter |
| Event tags, sticky notes, external IDs, and sync tokens | SQLAlchemy `JSON`; legacy startup repair includes PostgreSQL `JSONB` | Store canonical JSON text and validate on projection; never project sync tokens |
| Tenant isolation | PostgreSQL RLS policies, role grants, and application owner filters | D1 has no PostgreSQL RLS. Require authenticated `owner_id` in every prepared query and cross-user denial tests; never expose arbitrary owner input from the browser |
| Schema evolution | Alembic plus PostgreSQL-specific runtime `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` repairs | Use separate ordered D1 SQL migrations; never execute FastAPI startup repair SQL against D1 |
| WebSocket ticket consumption | Atomic authoritative `UPDATE ... RETURNING`, expiry, and one-time state | Excluded from D1 entirely |
| ORM sessions and transactions | Synchronous SQLAlchemy sessions, commits, rollbacks, relationships, and cascades | Not portable. Implement a dedicated JavaScript adapter with prepared D1 statements |
| IDs and booleans | PostgreSQL integers/sequences and booleans | Preserve source IDs as `INTEGER`; encode booleans as constrained `INTEGER` values `0`/`1` |
| JSON/date comparisons | PostgreSQL typing and Python serialization | Compare canonical UTC text only and parse JSON at the adapter boundary |

## Minimal projection

The projection supports only `GET /calendar/unified` persisted-event reads and derived account status. It contains no credentials and no source-of-truth write fields.

### `calendar_events_read`

- `owner_id INTEGER NOT NULL`
- `source_event_id INTEGER NOT NULL`
- `title TEXT NOT NULL`
- `description TEXT`
- `start_utc TEXT NOT NULL`
- `end_utc TEXT`
- `color TEXT`
- `color_enabled INTEGER NOT NULL CHECK (color_enabled IN (0, 1))`
- `tags_json TEXT`
- `sticky_note_json TEXT`
- `sticky_notes_json TEXT`
- `external_id TEXT`
- `external_ids_json TEXT`
- `source TEXT`
- `account_email TEXT`
- `account_key TEXT`
- `created_utc TEXT`
- `updated_utc TEXT`
- primary key: `(owner_id, source_event_id)`
- range index: `(owner_id, start_utc)`

### `calendar_account_status_read`

- `owner_id INTEGER NOT NULL`
- `account_key TEXT NOT NULL`
- `provider TEXT NOT NULL`
- `account_email TEXT`
- `status TEXT NOT NULL`
- `last_success_utc TEXT`
- `last_failure_utc TEXT`
- primary key: `(owner_id, account_key)`

This table stores a derived display status only. Access tokens, refresh tokens, sync tokens, provider secrets, and sentinel credentials are excluded.

### `projection_checkpoints`

- `projection_name TEXT PRIMARY KEY`
- `source_revision TEXT NOT NULL`
- `source_watermark_utc TEXT NOT NULL`
- `row_count INTEGER NOT NULL`
- `key_hash TEXT NOT NULL`
- `content_hash TEXT NOT NULL`
- `completed_utc TEXT NOT NULL`

The active checkpoint changes only after the complete snapshot/replay and reconciliation pass.

## Rebuild and reconciliation contract

1. Read a bounded snapshot from Supabase through an approved server-side exporter; never expose database credentials to the Worker.
2. Normalize UTC timestamps and JSON deterministically.
3. Load projection rows with immutable source revision and watermark metadata.
4. Compare source and D1 row counts, sorted key sets, normalized per-row hashes, aggregate content hash, and freshness watermark.
5. Activate the checkpoint only when every comparison matches.
6. On any difference, keep route ownership on Render and discard/rebuild the projection.

D1 Time Travel can recover a D1 database within its available retention window, but this projection's primary recovery is a full rebuild from Supabase. A restore must never overwrite Supabase or bypass reconciliation.

## Unsupported and excluded behavior

- Authoritative calendar, note, task, account, OAuth, ticket, secret, scheduler, or audit writes.
- PostgreSQL RLS, roles, grants, session variables, functions, or Alembic migrations.
- FastAPI startup schema mutation.
- Provider sync state or credentials.
- Request-handler dual writes.
- Automatic failover from Supabase to stale D1 data.

## Recommendation

Defer D1 implementation and deployment until Worker-native authentication, least-privilege access, and the shared read adapter gates pass. If those gates pass and a measured read-latency or origin-cost need remains, build the local SQL migration and Worker-runtime contract tests for this projection before creating a remote database or binding.
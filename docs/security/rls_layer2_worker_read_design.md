# Layer 2 RLS design for Worker reads

Date: 2026-08-02  
Status: Migration and tests implemented locally; production role, credential, gateway, and route remain unprovisioned.

## Role separation

Do not reuse the current Render table-owner role or the proposed write-capable `app_user` test role. Create a distinct Worker read role with these PostgreSQL attributes:

```sql
CREATE ROLE worker_calendar_reader
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOBYPASSRLS;
```

The role must not own schemas, tables, sequences, functions, policies, or migrations. Grant `CONNECT` to the application database, `USAGE` on the application schema, and column-level `SELECT` only for the first approved read use case.

## Request identity

After verifying a JWT, the database adapter begins a transaction and sets identity with a parameterized statement:

```sql
SELECT set_config('app.user_id', :verified_user_id, true);
```

The `true` setting makes identity transaction-local. Pool checkout must begin with no usable identity. Missing, empty, malformed, or stale identity must return zero rows. Browser input must never directly set this value.

## Initial calendar-read policy map

| Table | Ownership expression | Worker access |
| --- | --- | --- |
| `events` | `owner_id = current_setting('app.user_id', true)::integer` | Select approved event columns only |
| `notes` | An `EXISTS` join to an event owned by the current user | No grant until its own contract gate |
| `event_tag_color_settings` | `owner_id = current_setting('app.user_id', true)::integer` | No grant until its own contract gate |
| `date_sticky_notes` | `owner_id = current_setting('app.user_id', true)::integer` | No grant until its own contract gate |
| `tasks` | Direct owner, but outside the first calendar fixture | No grant until its own contract gate |
| `users` | Identity and legacy credential columns | No Worker grant |
| `oauth_accounts` | Contains encrypted provider credentials and sync state | No direct Worker grant; expose only derived key/status through the protected projection |
| `tv_diag_log` | User/device operational data | No Worker grant |
| `sync_efficiency_daily_rollups` | Global operational data | No Worker grant by default |
| `app_runtime_secrets` | Encrypted runtime secrets | Never grant |

Policies should use a safe helper that returns `NULL` instead of raising when identity is absent or malformed. The helper must be `STABLE`, use an empty `search_path`, and not be `SECURITY DEFINER` unless a separate review proves it necessary.

## Grant constraints

- No `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, sequence, function-execution, schema-create, or temporary-table privileges.
- Revoke `PUBLIC` privileges and set default privileges so new tables are not automatically readable.
- Do not expose token, credential, password-hash, sync-token, diagnostic-detail, or runtime-secret columns through column grants or views.
- Hyperdrive or another gateway may hold only this role's credential, never the Render owner credential.
- Migrations continue to run through a separate owner/migrator identity outside Worker request handling.

## Required tests

1. Same-user bounded event reads succeed and match the shared behavior fixture.
2. Cross-user event, note, tag-color, and sticky-note reads return no rows.
3. Missing, empty, nonnumeric, and stale `app.user_id` return no rows.
4. Every write and DDL statement fails.
5. `SET ROLE`, role creation, extension creation, policy changes, and schema ownership changes fail.
6. Credential-bearing tables and columns are inaccessible.
7. A pooled connection cannot observe the prior transaction's identity.
8. New tables receive no Worker grants by default.
9. Direct Render behavior remains unchanged while the Worker route is disabled.

## Delivery sequence

1. Implement the shared calendar-read behavior fixture.
2. Add a reviewed Alembic migration that creates the helper, role grants, and policies without embedding a password.
3. Provision the login password interactively in Supabase and store it only in the approved gateway.
4. Run PostgreSQL integration tests as owner, user A, user B, anonymous context, and Worker role.
5. Enable one Worker-native read route behind a kill switch and operator-only canary.
6. Reconcile Render and Worker results before any wider routing.

## Implementation evidence

Alembic revision `k964e55bbb88` creates the passwordless `worker_calendar_reader` role, safe identity helper, event-only RLS policy, approved event-column grants, and an identity-scoped security-barrier account-status view. The view derives only normalized `account_key` and `account_status`; the role has no direct OAuth-table or credential-column grant. The migration also revokes broad/default privileges and provides a downgrade that revokes database connectivity before removing the role. No credential, note, tag, sticky-note, task, user, diagnostic, or runtime-secret access is granted.

`app/tests/test_worker_calendar_reader_rls.py` always verifies the single Alembic head and structural least-privilege constraints. Its PostgreSQL cases exercise same-user and cross-user reads, malformed and transaction-local identity, write/DDL/credential/escalation denial, exact column grants, and upgrade/downgrade behavior. They skip when `TEST_DATABASE_URL` is absent locally and run against PostgreSQL 16 in the Cloudflare release verification job.

`platform/cloudflare/src/calendar-read.js` implements platform-neutral response assembly. `calendar-read-postgres.js` adds an events-only PostgreSQL adapter that sets transaction-local identity, performs the bounded query through RLS, rolls back failures, closes every client, and preserves dedup serialization behavior. `calendar-read-hyperdrive.js` creates request-scoped `pg` clients from the deliberately unbound `HYPERDRIVE_RLS_NO_CACHE` binding. Focused tests prove transaction order, RLS query scope, rollback/close behavior, event serialization, dedup expansion, and independent fail-soft behavior.

The eventual Hyperdrive configuration must be created with caching disabled. RLS identity and permission-sensitive reads must not use Hyperdrive query caching; a normal cache-enabled binding is not an acceptable substitute. The binding ID and role password remain outside the repository. No Worker route imports the adapter. Password provisioning, live PostgreSQL/Hyperdrive proof, route modes, shadow comparison, and canary traffic remain pending.

## Rollback

Disable the native route first. Revoke the Worker role's `CONNECT`, terminate its sessions, and remove the gateway credential. Policies may remain in place because Render continues through its existing role, but no Worker route may bypass the failed gate.
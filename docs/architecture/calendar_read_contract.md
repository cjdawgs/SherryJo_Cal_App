# Bounded calendar read contract

Date: 2026-08-02  
Route: `GET /calendar/unified`  
Contract version: 1  
Status: FastAPI and Worker persistence adapters plus route ownership controls implemented; Worker deployment remains forced to proxy.

## Authorization

- A bearer token is required.
- The token must decode to a `user_id` that resolves to an existing application user.
- Missing, invalid, expired, or ghost-user credentials return HTTP 401 before the use case runs.
- Event reads are always scoped to the authenticated user ID. Callers cannot provide another user ID.

## Request

| Field | Type | Default | Rule |
| --- | --- | --- | --- |
| `start` | ISO-8601 string | none | Used only when both `start` and `end` parse successfully |
| `end` | ISO-8601 string | none | Used only when both `start` and `end` parse successfully |
| `range_days` | integer | 30 | When either explicit bound is absent or invalid, read from current UTC time minus/plus this value |
| `dedup` | boolean | true | When false, linked provider identities may be emitted as separate event views |

ISO `Z` and offset timestamps are normalized to aware UTC datetimes. Naive ISO timestamps are interpreted as UTC.

## Filtering and ordering

- Include events where `owner_id` equals the authenticated user ID.
- Include events where `start_time >= start` and `start_time <= end`; both boundaries are inclusive.
- The route reads persisted events only. It does not contact calendar providers.
- Contract version 1 provides no event ordering guarantee because the current database query has no explicit `ORDER BY` clause. Consumers must not depend on row order.

## Response

HTTP 200 returns:

```json
{
  "events": [],
  "account_status": {},
  "account_event_totals": {}
}
```

- `events` contains the existing serialized event objects without field removal or renaming.
- `account_status` maps normalized `provider:lowercase-email` keys to the existing account status values.
- `account_event_totals` counts returned events by non-empty `account_key`.
- The exact platform-neutral fixture is `app/tests/fixtures/calendar_read_contract.json`.

## Failure behavior

- Authentication failures return HTTP 401.
- Invalid or incomplete explicit date bounds fall back to the `range_days` window rather than returning HTTP 422.
- A persisted-event read failure produces an empty `events` list and empty totals while account statuses may still be returned.
- An account-list failure produces an empty `account_status` object while events and totals may still be returned.
- An individual malformed account is omitted from `account_status` without failing the complete response.

These fail-soft HTTP 200 behaviors are preserved for compatibility. Changing them requires a new contract version and coordinated client tests.

## Architecture boundary

- `app/application/calendar_read.py` owns platform-neutral response assembly and defines the read port.
- `app/adapters/calendar_read_sqlalchemy.py` owns SQLAlchemy/service integration and compatibility error handling.
- `app/routers/calendar.py` owns HTTP authentication, query parsing, and date-window resolution.
- `platform/cloudflare/src/calendar-read-postgres.js` owns Worker event serialization, transaction-local identity, the bounded RLS query, and fail-soft response assembly.
- `platform/cloudflare/src/calendar-read-hyperdrive.js` creates request-scoped `pg` clients only from `HYPERDRIVE_RLS_NO_CACHE`.
- Account status comes from the identity-scoped `worker_calendar_account_status` security-barrier view. The Worker role receives only `account_key` and `account_status`; its query never names `oauth_accounts` or credential columns.
- The Worker entrypoint imports these adapters behind `proxy`, `shadow`, `canary`, and `native` ownership modes. Root and canary deployment configuration explicitly use `proxy`; non-proxy deployment remains blocked on live PostgreSQL proof, Hyperdrive compatibility, public-key provisioning, and shadow parity.
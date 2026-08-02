# Dual-platform threat model

Date: 2026-08-02  
Scope: Browser, Cloudflare Worker, Render/FastAPI, Supabase PostgreSQL, OAuth providers, WebSockets, future Cloudflare bindings, logs, and administrator actions.

## Decision boundary

The deployed Cloudflare Worker is a stateless reverse proxy with two unauthenticated native status routes. The repository also contains a strict JWT verifier, least-privilege calendar adapter, and route ownership controller, but both root and canary configuration force calendar reads to `proxy`. Render owns deployed authentication, authorization, business logic, provider integration, and database access. Supabase PostgreSQL is the sole authoritative data store.

This threat model does not authorize Worker-native authentication, direct database access, queues, D1, KV, R2, Durable Objects, or production traffic cutover. Each requires its later migration gate.

## Protected assets

- User identities, password hashes, roles, sessions, JWTs, and administrator authority.
- Calendar events, notes, tasks, sticky notes, TV diagnostics, and account metadata.
- Google, Microsoft, and iCloud credentials and refresh tokens.
- JWT signing material, credential-encryption keys, setup codes, provider client secrets, database credentials, and deployment API tokens.
- Supabase schema integrity, tenant isolation, migrations, backups, and authoritative data.
- OAuth callback integrity, provider grants, synchronization correctness, and replay resistance.
- Deployment provenance, logs, audit evidence, availability, and rollback capability.

## Trust boundaries and data flows

1. The browser sends HTTPS and WebSocket traffic to either Render directly or the Cloudflare Worker shadow endpoint.
2. The Worker terminates TLS, adds trusted forwarding metadata, and proxies requests to Render over HTTPS. It does not currently verify JWTs or access Supabase.
3. Render verifies JWTs, enforces user/admin dependencies, executes business rules, calls OAuth providers, and reads or writes Supabase.
4. OAuth providers redirect authorization responses to configured Render callback URLs. Render exchanges codes and stores encrypted provider credentials.
5. Repository code issues a short-lived one-time ticket for `/ws`; the currently deployed Render release still lacks that ticket route, so production validation remains blocked.
6. Supabase Layer 1 RLS revokes public `anon` and `authenticated` access. The current Render table-owner role bypasses RLS.
7. Logs and migration evidence may receive operational metadata but must never contain credentials, bearer tokens, private event content, or connection strings.

## Security invariants

- Supabase remains the only source of truth until the Worker write-autonomy gate passes.
- The Worker remains proxy-only for authenticated and business routes until asymmetric JWT verification, least-privilege data access, and tenant-isolation tests pass.
- No request handler may dual-write to Render and a Cloudflare store.
- Provider refresh tokens and `TOKEN_ENCRYPTION_KEY` remain outside Cloudflare unless a separately reviewed Worker-owned provider workflow requires them.
- Production database roles must fail closed, use PostgreSQL, and never fall back to SQLite.
- Redirects and OAuth callbacks must use approved HTTPS hosts and preserve state validation.
- Secrets are stored only in provider secret stores or approved interactive prompts, never Git, workbooks, screenshots, logs, URLs, or chat.
- A release cannot advance with an unmitigated Critical or High risk relevant to that release.

## Threat register

| ID | Surface | Threat | Current control | Required treatment before exposure | Severity | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T01 | Browser/Worker | Host-header or redirect manipulation sends users or credentials to an attacker host | Worker sets forwarding host/proto and rewrites only same-origin Render redirects; origin must use HTTPS | Add allowlisted public/origin hosts and negative redirect tests before custom-domain cutover | High | Mitigated for shadow; open for cutover |
| T02 | Worker/Render | Origin loop or SSRF through configurable origin | `ORIGIN_BASE_URL` is deployment configuration, HTTPS-only, and rejected when it matches the Worker host | Keep the value non-user-controlled; add deployment validation for the exact approved Render origin | High | Mitigated |
| T03 | Worker | Native route accidentally receives authentication or data authority without controls | Calendar ownership defaults and deploy config are `proxy`; invalid modes fail closed; non-proxy paths require strict JWT verification | Keep Hyperdrive/public keys unprovisioned until JWT, RLS, contract, shadow, and canary gates pass | Critical | Guardrail active; native deployment blocked |
| T04 | JWT | Shared HS256 secret copied to Cloudflare expands signing authority and blast radius | JWT signing remains on Render; opt-in RS256 signing and strict public-key verification pass overlap/retirement tests | Configure and deploy asymmetric keys, complete the bounded HS256 overlap, and verify Cloudflare public-key validation | Critical | Mitigated in code; blocks Worker auth until deployment |
| T05 | WebSocket | JWT in query string leaks through history, telemetry, proxy logs, or referrers | Authenticated issuance now returns a 60-second random ticket; only its SHA-256 hash is stored and atomic consumption prevents replay | Deploy the ticket migration and verify direct Render/Cloudflare valid-ticket handshakes before cutover | High | Mitigated in code; deployment evidence pending |
| T06 | Supabase | Render owner role bypasses RLS, allowing a coding defect to cross tenant boundaries | FastAPI ownership checks; public PostgREST roles revoked by Layer 1 | Provision a `NOBYPASSRLS`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE` role with per-user policies and denial tests | Critical | Open; blocks direct Worker DB access |
| T07 | Supabase/Worker | Worker database credentials permit writes or schema changes | Worker has no database binding | Use a read-only least-privilege role through an approved gateway; deny DDL, writes, role changes, and cross-user reads | Critical | Not exposed |
| T08 | OAuth | Callback confusion, CSRF, code replay, or hostname mismatch compromises provider grants | Signed state handling and configured provider callback URLs remain on Render | Register exact canary host, preserve Render recovery callbacks, test state replay and callback-host mismatch | High | Partially mitigated |
| T09 | Provider credentials | Refresh token or app password disclosure enables external account access | Credentials are encrypted at rest; `MultiFernet.rotate()` reseals ciphertext under the active key; overlap and old-key-removal tests pass | Perform the owner-controlled production rotation/recovery drill and retain value-free evidence | Critical | Mitigated in code; operator drill pending |
| T10 | Secrets | API keys or connection strings enter Git, logs, evidence, or workbooks | Gitleaks CI is configured; current task-file credentials were removed; baseline evidence rejects secret values | Rotate the exposed Supabase credential and resolve the historical scan finding before accepting a clean scan | High | Incident response open |
| T11 | Admin | Stolen or overprivileged admin session performs destructive operations | Admin dependency and explicit destructive confirmations | Add auditable admin action records, session-lifetime review, and high-risk reauthentication decision | High | Open |
| T12 | Logs | Tokens or private payloads are captured in exception text or request URLs | Final formatted log output centrally redacts authorization, cookies, credentialed database URLs, query tokens/tickets, secret assignments, and exception text | Verify the formatter in deployed Render logs without submitting real credentials | High | Mitigated in code; deployment evidence pending |
| T13 | Queue/Cron | Retries or replay duplicate provider writes | No Cloudflare Queues/Cron business workflow exists | Require operation IDs, idempotency, deduplication, bounded retries, and dead-letter handling | High | Not exposed |
| T14 | D1 | Stale or divergent read model is treated as authoritative | D1 is not configured | Make it rebuildable and read-only; add reconciliation, freshness, and full rebuild drills | High | Not exposed |
| T15 | KV/R2 | Sensitive or tenant data receives incorrect cache/storage policy | No bindings exist | Document classification, encryption, retention, tenant keys, cache invalidation, and deletion semantics first | High | Not exposed |
| T16 | Durable Objects | Stateful coordination bypasses authorization or leaks across tenants | No binding exists | Partition by non-guessable tenant/user identity and verify authorization on every RPC/WebSocket message | High | Not exposed |
| T17 | Availability | Worker, Render sleep, provider failure, or database outage breaks workflows | Direct Render synthetic workflow, Worker rollback, and database fail-closed controls exist | Enable independent monitoring, define SLO/RTO/RPO, and complete a timed bypass/failback with backup evidence | Medium | Partially mitigated; drill pending |
| T18 | Supply chain/deployment | Unreviewed code or wrong deployment SHA reaches production | GitHub CI, exact-SHA Admin status, Worker tests, Wrangler dry-run, and parity checks | Add post-deploy smoke promotion and least-privilege deployment tokens | High | Partially mitigated |

## Required security designs

### JWT transition

Render should become the sole asymmetric signer. Render and Cloudflare may verify with public keys, but Cloudflare must not receive private signing material. Tokens must bind issuer and audience, use an allowlisted algorithm, include expiry and `kid`, and reject unknown keys. During rotation, publish old and new public keys, sign new tokens with the new key, retain the old public key for no longer than the maximum token lifetime plus clock skew, then remove it. Existing HS256 tokens require a documented overlap verifier on Render only; they must not grant Worker-native access.

### Layer 2 RLS and Worker read role

Create separate login and group roles through an Alembic migration reviewed by the database owner. The Worker role must be `NOBYPASSRLS`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, have no schema ownership, receive only `USAGE` on the application schema and `SELECT` on approved tables, and have no default privileges beyond those grants. Each transaction must set a server-controlled user identifier used by `USING` policies. Tests must prove same-user reads, cross-user denial, anonymous denial, write denial, DDL denial, role-change denial, and failure when user context is absent.

### WebSocket authentication

Implemented design: authenticated `POST /ws/ticket` creates a random, single-use ticket stored as a SHA-256 hash with user ID, expiry, and consumed state. The browser connects with only that 60-second ticket; Render atomically consumes it before accepting the socket. Reuse, expiry, missing tickets, and the former JWT `token` query parameter are rejected. Production deployment and valid-ticket checks through direct Render and Cloudflare remain required evidence.

## Review gates

- Stage A2 cannot pass until T04, T05, T06, T09, T10, and T12 have tested mitigations or an explicitly approved non-production deferral.
- Worker-native authenticated reads cannot begin until T04, T06, and T07 pass.
- OAuth canary cannot begin until callback/state tests and log redaction pass.
- Production edge cutover cannot begin until T01, T05, T12, and independent rollback monitoring pass.
- Cloudflare async or persistence bindings cannot be introduced until their corresponding not-exposed threats have approved designs and tests.

## Evidence references

- `platform/cloudflare/src/worker.js`
- `platform/cloudflare/test/worker.test.js`
- `deployment/platform_contract.py`
- `deployment/shadow_parity.py`
- `docs/security/production_runbook.md`
- `docs/security/rls_layer1.sql`
- `docs/security/secret_inventory.md`
- `docs/security/jwt_transition.md`
- `docs/security/rls_layer2_worker_read_design.md`
- `app/routers/websocket.py`
- `app/tests/test_security_authz.py`
- `app/tests/test_jwt_rotation.py`
- `app/tests/test_logging_usage.py`
- `app/tests/test_security_rls.py`
- `artifacts/baselines/production-baseline-20260801T201836Z.md`
- `artifacts/baselines/stage-a1-baseline-20260801-173813.md`

## Review record

Initial engineering draft completed on 2026-08-02. Rotation and centralized log-redaction tests pass, and CI secret scanning is configured. A tracked VS Code task contained a Supabase credentialed URL; all current-tree copies were removed, but owner rotation and historical-scan response are mandatory before approval. Production WebSocket/JWT evidence and owner review also remain pending.
# Production security runbook

Operator steps that cannot be shipped in code. Everything else in this
change applies automatically at boot.

## 1. Render environment variables

The app now refuses to boot on Render unless all of these are set
(`app/config.py::validate_runtime_configuration`). Render is detected through
the `RENDER` / `RENDER_SERVICE_ID` variables the platform injects.

| Variable | Value | Why |
| --- | --- | --- |
| `TOKEN_ENCRYPTION_KEY` | output of the generator below | OAuth tokens and iCloud app passwords are encrypted with it |
| `ADMIN_SETUP_CODE` | a long random string | without it, admin self-registration is refused outright |
| `DISABLE_SQLITE_FALLBACK` | `1` | stops a Postgres outage from silently degrading to a throwaway SQLite file |
| `REQUIRE_DB_KIND` | `postgres` | asserts the resolved database is the intended one |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | existing values | already required |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` / `MS_TENANT_ID` | existing values | already required |
| `JWT_SECRET_KEY` | existing value | already required |

Generate the encryption key:

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Store it somewhere durable. **Losing it makes every stored OAuth token
unrecoverable** — accounts would have to be reconnected.

To rotate: set `TOKEN_ENCRYPTION_KEY=<new-key>,<old-key>` and redeploy. The
first key encrypts, every listed key decrypts, and the startup sweep re-seals
existing rows with the new key. Drop the old key on the next deploy.

## 2. Layer-1 RLS on Supabase

`app/db_security.py` applies this at every boot, and
`alembic/versions/h960a11ddd44_enable_rls_layer1.py` carries the same change in
the migration chain. If the Render database role cannot alter the schema, run
`docs/security/rls_layer1.sql` once in the Supabase SQL editor instead; it is
idempotent and ends with a verification query.

This enables RLS on all eight tables and strips every grant from the `anon` and
`authenticated` roles, which is what closes the public PostgREST surface at
`https://<project>.supabase.co/rest/v1/*`. The application connects as the table
owner and therefore bypasses RLS, so no application behaviour changes.

Layer 2 — a dedicated `NOBYPASSRLS` `app_user` role with `app.user_id`-driven
policies — is **not** part of this change. `app/tests/test_security_rls.py`
already contains the tests for it; they skip until the role is provisioned.

## 3. Enable the test workflow

Copy `docs/security/ci-tests-workflow.yml` to `.github/workflows/tests.yml` and
commit it. It runs `pytest app/tests` on every push and pull request with a
PostgreSQL service attached, which is what makes the RLS tests execute rather
than skip. It ships as a doc because the PR automation is not granted GitHub's
`workflow` scope.

## 4. Verification after deploy

```bash
# Public data API must be closed
curl -s -H "apikey: $SUPABASE_ANON_KEY" \
  "https://dtgbcftlciolnrenzicb.supabase.co/rest/v1/oauth_accounts?select=*"
# expect: permission denied for table oauth_accounts

# Startup log should contain
#   🔒 [RLS] Row Level Security enforced on 8 tables.
#   🔐 [CRYPTO] Sealed credentials for N oauth_accounts row(s).
```

Then confirm in Supabase that `oauth_accounts.access_token` values start with
`v1:`, and that the admin table browser shows `***` for every credential column.

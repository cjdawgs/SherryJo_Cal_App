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
| `ADMIN_RECOVERY_CODE` | the same high-entropy secret in every active runtime | permits lockout recovery of the shared database-backed Master Admin Code |
| `DISABLE_SQLITE_FALLBACK` | `1` | stops a Postgres outage from silently degrading to a throwaway SQLite file |
| `REQUIRE_DB_KIND` | `postgres` | asserts the resolved database is the intended one |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | existing values | already required |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` / `MS_TENANT_ID` | existing values | already required |
| `JWT_SECRET_KEY` | existing value | already required |

### Shared Master Admin Code

The Master Admin Code authorizes only new Admin enrollment. It is not a user's
login password. Render and Cloudflare verify the same Argon2id hash in the
shared PostgreSQL table; the raw code is never returned by an API.

1. Apply the Alembic migrations with `alembic upgrade head` before deploying
   both runtimes.
2. Set `ADMIN_RECOVERY_CODE` in the Render service's **Environment** settings.
   In Cloudflare, add the same value as a secret under **Workers & Pages →
   sherryjo-cal-app → Settings → Variables and Secrets**, then repeat for
   **sherryjo-cal-app-canary**. Use one high-entropy value of at least 32
   characters for all three runtimes and keep it in an approved password
   manager. Never commit or share it in chat.
3. If an Admin can sign in, open **Admin → Master Admin Code**, enter a new
   code of 16–256 characters, and choose **Set / Rotate Master Admin Code**.
   The change is immediately shared by Render and Cloudflare.
4. If every Admin is locked out, open **Login → Create Account**, select
   **Admin** for the account type, then expand **Lost the Master Admin Code?
   Reset it**. Enter `ADMIN_RECOVERY_CODE`, then enter and confirm the new
   Master Admin Code. This resets only Admin enrollment; it does not change any
   existing account's login password.
5. Use the new Master Admin Code to enroll a replacement Admin account. After
   verifying the account can sign in, rotate the Master Admin Code again if
   the recovery process exposed it.

`ADMIN_RECOVERY_CODE` must match across active runtime secret stores. Platform
secret values are write-only, so the Admin page cannot confirm that they match.
The legacy `ADMIN_SETUP_CODE` environment variable is no longer used and can
be removed after the deployment has been upgraded.

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

This enables RLS on all registered application tables and strips every grant from the `anon` and
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
#   🔒 [RLS] Row Level Security enforced on the registered application tables.
#   🔐 [CRYPTO] Sealed credentials for N oauth_accounts row(s).
```

Then confirm in Supabase that `oauth_accounts.access_token` values start with
`v1:`, and that the admin table browser shows `***` for every credential column.

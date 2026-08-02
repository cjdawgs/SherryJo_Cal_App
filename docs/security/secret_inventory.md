# Production secret inventory

Date: 2026-08-02  
Rule: This inventory records names and handling requirements only. Never add values, fingerprints, partial values, screenshots, or recovery codes.

| Secret or credential | Owner/source | Current runtime | Storage | Rotation | Recovery | Cloudflare allowed? |
| --- | --- | --- | --- | --- | --- | --- |
| `DATABASE_URL` / PostgreSQL password | Supabase owner | Render | Render secret environment | Create replacement role/password, update Render, verify, revoke old credential | Supabase dashboard/database owner | Only a separate least-privilege Worker read credential after the RLS gate; never the Render owner credential |
| `JWT_SECRET_KEY` | Application owner | Render | Render secret environment | Current HS256 rotation requires coordinated token invalidation; replace through asymmetric transition | Owner-held secret record; forced reauthentication if lost | No |
| Future JWT private signing key | Application owner | Render signer only | Render secret environment or managed signer | Add new `kid`, publish public key, overlap, switch signer, retire old key | Offline owner backup or managed-key recovery | No |
| Future JWT public verification keys | Application owner | Render and Worker verifiers | Nonsecret configuration/JWKS | Publish new key before signing; retire after token lifetime plus skew | Rebuild from retained public key | Yes; public material only |
| `TOKEN_ENCRYPTION_KEY` keyring | Application owner | Render | Render secret environment; encrypted bootstrap persistence where documented | Set new key first and old keys after it, redeploy/reseal, verify, remove old key next deploy | Durable owner backup; otherwise reconnect every provider account | No unless Worker later owns encrypted provider credentials |
| `ADMIN_SETUP_CODE` | Application owner | Render | Render secret environment | Replace immediately after suspected disclosure; verify admin registration behavior | Generate a new high-entropy value | No while Render owns admin registration |
| `GOOGLE_CLIENT_SECRET` | Google Cloud project owner | Render | Render secret environment | Create replacement, update Render, test callback/refresh, revoke old secret | Google Cloud Console | Only if a reviewed Worker-native Google callback is approved |
| `MS_CLIENT_SECRET` | Microsoft Entra application owner | Render | Render secret environment | Add replacement, update Render, test callback/refresh, remove old credential | Entra admin center | Only if a reviewed Worker-native Microsoft callback is approved |
| Google/Microsoft client IDs and tenant ID | Provider application owner | Render/browser configuration | Environment/configuration | Update only with provider-app migration | Provider dashboards | Yes when required; identifiers are not authentication secrets |
| OAuth access and refresh tokens | End user/provider | Render and Supabase | Encrypted database columns | Provider refresh/reconnect; revoke provider grant on compromise | User reconnects account | No while Render owns provider synchronization |
| iCloud app passwords | End user/Apple | Render and Supabase | Encrypted credential storage | Revoke and create a new app password | Apple account recovery | No while Render owns provider synchronization |
| `GITHUB_TOKEN` / `GH_TOKEN` | Repository owner | Render Admin integration or CI | Provider secret store | Replace token, update secret store, revoke old token | GitHub token settings | No Worker need identified |
| Render API key | Render account owner | Operator tooling only | Password manager or interactive process environment | Create replacement and revoke old key | Render account settings | No |
| Render deploy hook URL | Render service owner | Admin/operator automation | Render/GitHub secret store | Regenerate hook, update caller, invalidate old hook | Render service settings | Only if an approved deployment workflow needs it |
| Cloudflare API token | Cloudflare account owner | Wrangler/CI/operator tooling | Cloudflare/GitHub secret store or interactive environment | Create least-privilege replacement, verify, revoke old token | Cloudflare API Tokens | It authenticates to Cloudflare but must not be exposed to Worker code |
| Designated test-account email/password | Application owner | GitHub Actions | `SHERRYJO_SMOKE_EMAIL` and `SHERRYJO_SMOKE_PASSWORD` secrets | Rotate application credential and update Actions secrets | Owner restores access to the designated test account | Not as a Worker binding |
| Future Worker database read credential | Supabase owner | Worker/Hyperdrive | Cloudflare secret or Hyperdrive configuration | Create replacement role password, overlap gateway config, verify RLS, revoke old password | Supabase owner using reviewed role DDL | Yes, only after Layer 2 tests pass |
| Future WebSocket ticket signing/storage secret | Application owner | Render ticket issuer/consumer | Prefer random server-side ticket records; otherwise Render secret store | Rotate with bounded overlap shorter than ticket TTL | Generate replacement; active tickets may expire | No current need |

## Rotation rules

1. Rotate through provider dashboards or interactive secret prompts. Never pass values in command arguments, chat, workbooks, committed files, or screenshots.
2. Add/verify/revoke is the default sequence. Revoke first only when active compromise requires immediate containment.
3. Record the date, credential name, operator, affected runtime, verification result, and revocation result without recording the value.
4. Deployment tokens must use the narrowest account/resource and permission scope available.
5. A lost `TOKEN_ENCRYPTION_KEY` is a recovery event because provider credentials cannot be decrypted; reconnect affected accounts.
6. A leaked JWT signing key is an authentication incident; replace the key, reject the compromised `kid`, and require reauthentication.

## Current placement decision

Cloudflare currently receives only `ORIGIN_BASE_URL`, which is not secret. No JWT signing key, provider client secret, provider token, database owner credential, setup code, or encryption key may be copied to Cloudflare during the proxy-only phase.

## Open credential response

The 2026-08-02 repository sweep found a Supabase credentialed database URL duplicated in the tracked VS Code task file. Every current-tree copy was removed and those tasks now require `SHERRYJO_E2E_DB_URL` from the caller environment. Because Git history may retain the former value, the database owner must rotate that credential, update only approved secret stores, verify application connectivity, revoke the old credential, and record value-free evidence. Gitleaks history findings must not be allowlisted merely because the current tree is clean.
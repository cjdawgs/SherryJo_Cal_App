# Production baseline evidence

Generated: `2026-08-05T15:18:45.341583+00:00`
Repository commit: `e51bb421321129495b0339e3b9b54d292e73d7fd`
Alembic heads: `ab982v22ooo66, bb981v22nnn55`

## Public targets

| Target | URL | Probe | HTTP | Status | Schema | SHA-256 |
| --- | --- | --- | ---: | --- | --- | --- |
| render | https://sherryjo-cal-app.onrender.com | `/health` | 200 | ok | ok | `972019cacfd7793eb0b21cac8f5818e77c92e9b75a7bcf97207772f9e22ad118` |
| render | https://sherryjo-cal-app.onrender.com | `/openapi.json` | 200 |  |  | `192bb98423671941244bc9580aa81f5722e95004f4b02723fc2714e2cfabda56` |
| cloudflare | https://sherryjo-cal-app.realty-cal.workers.dev | `/__edge/health` | 200 | ok | None | `0189e38b80debf64725a34f2b25fe4a889046da89fc310eb7b72da371a442176` |
| cloudflare | https://sherryjo-cal-app.realty-cal.workers.dev | `/health` | 200 | ok | ok | `972019cacfd7793eb0b21cac8f5818e77c92e9b75a7bcf97207772f9e22ad118` |
| cloudflare | https://sherryjo-cal-app.realty-cal.workers.dev | `/api/platform/status` | 200 | ok | None | `3bbfe40f701104b5ee0cd5ac75f78c7bb903a128f8edf959caaace95279eac1e` |
| cloudflare | https://sherryjo-cal-app.realty-cal.workers.dev | `/openapi.json` | 200 |  |  | `192bb98423671941244bc9580aa81f5722e95004f4b02723fc2714e2cfabda56` |

## Environment presence

Only presence is recorded; values are never included.

- `ADMIN_SETUP_CODE`: not configured
- `AUTHORIZATION`: not configured
- `BASELINE_BEARER_TOKEN`: not configured
- `BASE_URL`: not configured
- `CLOUDFLARE_API_TOKEN`: not configured
- `DATABASE_URL`: not configured
- `DB_TYPE`: not configured
- `DISABLE_SQLITE_FALLBACK`: not configured
- `GH_TOKEN`: not configured
- `GITHUB_TOKEN`: configured
- `GOOGLE_CLIENT_ID`: not configured
- `GOOGLE_CLIENT_SECRET`: not configured
- `GOOGLE_REDIRECT_URI`: not configured
- `JWT_ALGORITHM`: not configured
- `JWT_SECRET_KEY`: not configured
- `MS_CLIENT_ID`: not configured
- `MS_CLIENT_SECRET`: not configured
- `MS_REDIRECT_URI`: not configured
- `MS_TENANT_ID`: not configured
- `RENDER_API_KEY`: not configured
- `REQUIRE_DB_KIND`: not configured
- `TOKEN_ENCRYPTION_KEY`: not configured

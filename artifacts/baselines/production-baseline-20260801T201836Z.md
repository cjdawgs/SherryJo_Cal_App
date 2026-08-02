# Production baseline evidence

Generated: `2026-08-01T20:18:31.477054+00:00`
Repository commit: `1c762c6ab92255cd6998487f2df0f3acd809897b`
Alembic heads: `i962c33fff66`

## Public targets

| Target | URL | Probe | HTTP | Status | Schema | SHA-256 |
| --- | --- | --- | ---: | --- | --- | --- |
| render | https://sherryjo-cal-app.onrender.com | `/health` | 200 | ok | ok | `972019cacfd7793eb0b21cac8f5818e77c92e9b75a7bcf97207772f9e22ad118` |
| render | https://sherryjo-cal-app.onrender.com | `/openapi.json` | 200 |  |  | `036ca02f990c32c2bb3176c5283e1e71d033462c9f44ee53091b1b8686ab290b` |
| cloudflare | https://sherryjo-calendar-edge.realty-cal.workers.dev | `/__edge/health` | 200 | ok | None | `0189e38b80debf64725a34f2b25fe4a889046da89fc310eb7b72da371a442176` |
| cloudflare | https://sherryjo-calendar-edge.realty-cal.workers.dev | `/health` | 200 | ok | ok | `972019cacfd7793eb0b21cac8f5818e77c92e9b75a7bcf97207772f9e22ad118` |
| cloudflare | https://sherryjo-calendar-edge.realty-cal.workers.dev | `/api/platform/status` | 200 | ok | None | `f60bbd6e9b2ad46311f7b568cc558f9a21ef764cbb070f7edc33c1b62df9b986` |
| cloudflare | https://sherryjo-calendar-edge.realty-cal.workers.dev | `/openapi.json` | 200 |  |  | `036ca02f990c32c2bb3176c5283e1e71d033462c9f44ee53091b1b8686ab290b` |

## Environment presence

Only presence is recorded; values are never included.

- `ADMIN_SETUP_CODE`: not configured
- `AUTHORIZATION`: not configured
- `BASELINE_BEARER_TOKEN`: not configured
- `BASE_URL`: configured
- `CLOUDFLARE_API_TOKEN`: not configured
- `DATABASE_URL`: configured
- `DB_TYPE`: configured
- `DISABLE_SQLITE_FALLBACK`: configured
- `GH_TOKEN`: not configured
- `GITHUB_TOKEN`: not configured
- `GOOGLE_CLIENT_ID`: configured
- `GOOGLE_CLIENT_SECRET`: configured
- `GOOGLE_REDIRECT_URI`: configured
- `JWT_ALGORITHM`: configured
- `JWT_SECRET_KEY`: configured
- `MS_CLIENT_ID`: configured
- `MS_CLIENT_SECRET`: configured
- `MS_REDIRECT_URI`: configured
- `MS_TENANT_ID`: configured
- `RENDER_API_KEY`: not configured
- `REQUIRE_DB_KIND`: not configured
- `TOKEN_ENCRYPTION_KEY`: not configured

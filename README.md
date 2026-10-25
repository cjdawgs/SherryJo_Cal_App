# SherryJo Cal App

## 📌 Overview
This is a backend system built with FastAPI that powers a multi-user calendar and business operations application.

The system includes authentication, role-based access control, event management, and real-time communication via WebSockets.

---

## ✅ Current Features

### 🔐 Authentication
- User registration
- User login (JWT tokens)
- Password hashing (secure)

### 👮 Role-Based Access Control (RBAC)
- Roles: `admin`, `staff`
- Admin-only endpoints enforced

### 📅 Events System
- Create events
- Retrieve events
- Update event notes ("sticky notes")
- Status tracking

### ⚡ Real-Time System
- WebSocket endpoint (`/ws`)
- Live message exchange (client ↔ server)

---

## ⚙️ Tech Stack

- FastAPI
- PostgreSQL
- SQLAlchemy
- JWT (python-jose)
- Passlib (argon2)
- WebSockets

---

## 🚀 How to Run

### 1. Activate environment

### FireTV Quick Launch Guide

See [docs/quick_launch_firetv.md](docs/quick_launch_firetv.md) for the FireTV remote map, zoom controls, home zoom preferences, and settings panel usage.

## Configuration Safety Rules

- `ADMIN_SETUP_CODE` must be set (host env or secret store) before any admin account can be registered via `POST /auth/register`. Admin registration is rejected when it is unset.
- `/ws` requires a JWT: connect to `/ws?token=<access_token>`.

- Local development can use .env.
- Production and staging must use host environment variables or secret store values.
- Local .env is never allowed to override production runtime values.
- OAuth callback URLs are resolved at runtime using forwarded host/proto when available.
- BASE_URL can still be set explicitly, but DevTunnel and proxy hosts are auto-detected from request headers.

## Post-Deploy Smoke Test

Run this after deploying to your server (including DevTunnel-exposed environments):

```powershell
.venv\Scripts\python.exe scripts\deployment_smoke_test.py --base-url https://your-tunnel-id.devtunnels.ms --email your_user@email.com --password your_password
```

Alternative with pre-existing bearer token:

```powershell
.venv\Scripts\python.exe scripts\deployment_smoke_test.py --base-url https://your-tunnel-id.devtunnels.ms --token YOUR_BEARER_TOKEN
```

## Commit And Push Workflow

Use the repository-tracked script when you want a guided commit/push flow:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Commit_SherryJo_Calendar_App.ps1
```

What it does:
- Blocks commits when merge/rebase conflicts are unresolved.
- Updates `FileRequirements.txt` before staging so dependency snapshots stay in sync.
- Lets you choose staging mode: all changes, tracked-only, or manual file list.
- Skips commit/push when nothing is staged.

## Database Mode Guardrails (Foolproof Setup)

The app supports dynamic DB selection, but now includes fail-safe environment guardrails to prevent accidental fallback when you forget environment settings.

Environment flags:
- `REQUIRE_DB_KIND`: `postgres` or `sqlite`
- `DISABLE_SQLITE_FALLBACK`: `1`/`true` to fail fast if primary DB cannot connect

Recommended presets:
- Local SQLite testing:
	- `REQUIRE_DB_KIND=sqlite`
	- `DISABLE_SQLITE_FALLBACK=0`
	- `DATABASE_URL=sqlite:///./app.db` (or unset `DATABASE_URL` and set `DB_TYPE=sqlite`)
- Local Supabase/Postgres testing (strict):
	- `REQUIRE_DB_KIND=postgres`
	- `DISABLE_SQLITE_FALLBACK=1`
	- `DATABASE_URL=<your supabase postgres URL>`
- Staging/Production (strict):
	- `REQUIRE_DB_KIND=postgres`
	- `DISABLE_SQLITE_FALLBACK=1`

This ensures staging/prod never silently run against SQLite when Postgres is unreachable.

## Admin Database Runtime Control

The Admin page's Database Runtime Control panel can test and save a local SQLite or PostgreSQL connection. For a local origin, credentials are saved in the repository-root `.env` file with owner-only file permissions, while the API returns only masked connection metadata. Selecting a saved profile reuses its server-side credentials; its password and full connection URL are never sent back to the browser.

To prepare a new PostgreSQL database without locking yourself out of the current one, use **Test Connection**, then **Save Profile Only**. This initializes missing application tables but does not switch the active database. Copy the required data from the active source into that saved target, then use **Save & Connect**. **Disconnect to SQLite** switches the local origin to `SQLITE_PATH` (or `./app.db`) and does not copy PostgreSQL records; confirm the target has an admin account before switching. Saved PostgreSQL profiles remain available for reconnecting.

Hosted origins must use their hosting provider's environment secrets and cannot save database settings into an ephemeral `.env` file. The Cloudflare Worker uses its configured Hyperdrive binding; its Admin panel can test that live connection and may update Hyperdrive only when Cloudflare API editing is configured. A Worker cannot switch to SQLite.

## VS Code Run Profiles (Explicit DB Mode)

Use Run and Debug to choose DB mode every time you launch locally.

- Profile: SherryJo: postgres-strict
	- Uses env file values for DATABASE_URL
	- Forces Postgres: REQUIRE_DB_KIND=postgres
	- Disables SQLite fallback: DISABLE_SQLITE_FALLBACK=1

- Profile: SherryJo: sqlite-local
	- Forces local SQLite: DATABASE_URL=sqlite:///./app.db
	- Requires SQLite: REQUIRE_DB_KIND=sqlite
	- Keeps fallback allowed: DISABLE_SQLITE_FALLBACK=0

Launch profiles are defined in .vscode/launch.json.

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

## Configuration Safety Rules

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

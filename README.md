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

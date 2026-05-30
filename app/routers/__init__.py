r"""
Router package registry.

This file makes router loading deterministic, so these both work:
- from app.routers import auth, users, events, display, websocket
- from app.routers import all_routers

Router package registry.

Purpose:
- Ensures deterministic router loading
- Provides a single import location for all routers
- Keeps main.py clean and scalable

Usage:
    from app.routers import all_routers

    for router in all_routers:
        app.include_router(router)


"""


# ✅ Import modules so they are discoverable
# (supports: from app.routers import auth, users, etc.)
from . import (
    auth,
    users,
    events,
    display,
    websocket,
    tasks,
    calendar,
    notes,
    admin,
    oauth,   # ✅ now lives in routers folder
    google_auth,   # ✅ Google OAuth
    accounts,  # ✅ Multi-account OAuth management
)  # noqa: F401


# Export router objects (so main.py can include them consistently)

# ✅ Import router objects explicitly
# This keeps naming consistent and avoids attribute confusion
from .auth import router as auth_router
from .users import router as users_router
from .events import router as events_router
from .tasks import router as tasks_router
from .calendar import router as calendar_router
from .notes import router as notes_router
from .display import router as display_router
from .websocket import router as websocket_router
from .oauth import router as oauth_router   # ✅ now local import
from .google_auth import router as google_auth_router
from .accounts import router as accounts_router  # ✅ Multi-account OAuth
from .admin import router as admin_router



# ✅ Central router registry
# Order does not usually matter, but keeping it structured helps debugging
all_routers = [
    auth_router,        # Auth endpoints (/auth/*)
    oauth_router,       # ✅ Microsoft OAuth (/ms/*)
    google_auth_router,   # ✅ Google OAuth
    accounts_router,    # ✅ Multi-account OAuth management
    admin_router,   # ✅ NEW ADMIN MANAGEMENT

    users_router,
    events_router,
    tasks_router,
    calendar_router,
    notes_router,

    display_router,
    websocket_router,
]

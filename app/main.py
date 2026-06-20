
# ==================================================
# IMPORTS
# ==================================================

from fastapi import FastAPI, Request
from fastapi.openapi.utils import get_openapi
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import inspect, text

from app.database import engine, Base

# ✅ Import ALL routers from your central router registry
from app.routers import all_routers


# ✅ NEW: Import background scheduler
from app.services.sync_scheduler import start_scheduler



# ==================================================
# CREATE FASTAPI APP
# ==================================================

app = FastAPI(
    title="SherryJo App",
    version="1.0"
)


# ==================================================
# ✅ ENABLE CORS (ALLOW FRONTEND TO CALL API)
# ==================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # ✅ allow all (safe for dev)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==================================================
# DATABASE INITIALIZATION
# ==================================================

# ✅ IMPORTANT:
# This ensures SQLAlchemy knows about all models before creating tables
from app import models  # DO NOT REMOVE

# ✅ Create tables (safe for dev; in prod you'd use migrations)
Base.metadata.create_all(bind=engine)

# ✅ Ensure local SQLite schema is up to date for optional columns
if engine.url.drivername.startswith("sqlite"):
    inspector = inspect(engine)
    if "oauth_accounts" in inspector.get_table_names():
        columns = {col["name"] for col in inspector.get_columns("oauth_accounts")}
        required_columns = {
            "last_sync_success",
            "last_sync_failure",
            "last_error",
            "status",
            "token_expires_at",
            "updated_at"
        }
        missing = required_columns - columns
        if missing:
            print(f"⚠️ SQLite schema missing columns: {missing}. Applying ALTER TABLE fixes.")
            with engine.connect() as conn:
                for col in missing:
                    if col == "last_sync_success":
                        conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN last_sync_success DATETIME"))
                    elif col == "last_sync_failure":
                        conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN last_sync_failure DATETIME"))
                    elif col == "last_error":
                        conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN last_error VARCHAR"))
                    elif col == "status":
                        conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN status VARCHAR DEFAULT 'ok'"))
                    elif col == "token_expires_at":
                        conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN token_expires_at DATETIME"))
                    elif col == "updated_at":
                        conn.execute(text("ALTER TABLE oauth_accounts ADD COLUMN updated_at DATETIME"))
                conn.commit()
            print("✅ SQLite schema upgrade complete.")

print("✅ Tables registered:", Base.metadata.tables.keys())


# ==================================================
# TEMPLATE ENGINE (JINJA2)
# ==================================================

# ✅ Loads HTML templates from /app/templates
templates = Jinja2Templates(directory="app/templates")


# ==================================================
# STATIC FILES (CSS, JS)
# ==================================================

# ✅ Serves static assets at /static
app.mount("/static", StaticFiles(directory="app/static"), name="static")


# ==================================================
# REGISTER ROUTERS
# ==================================================
# ✅ Dynamically include all routers
for r in all_routers:
    app.include_router(r)



# ==================================================
# ✅ BACKGROUND JOBS (NEW)
# ==================================================

@app.on_event("startup")
def start_background_jobs():
    """
    Runs when FastAPI starts.

    Purpose:
    - Start background scheduler
    - Automatically sync Outlook events periodically

    IMPORTANT:
    This ensures:
    - No manual API calls needed
    - System stays in sync with Outlook
    """
    start_scheduler()


# ==================================================
# MAIN PAGE (UI ENTRY POINT)
# ==================================================

@app.get("/")
def home(request: Request):
    """
    ✅ Landing page for your app UI
    """

    
    return templates.TemplateResponse(
        request,
        "index.html",
        {"request": request}
    )


@app.get("/calendar-ui")
def calendar_ui(request: Request):
    
    return templates.TemplateResponse(
        request,
        "index.html",
        {"request": request}
    )



@app.get("/login")
def login_page(request: Request):
    return templates.TemplateResponse(
        request,
        "login.html",
        {"request": request}
    )

# ==================================================
# HEALTH CHECK
# ==================================================

@app.get("/health")
def health_check():
    """
    ✅ Simple health endpoint (used by tests + monitoring)
    """
    return {"status": "ok", "app": "running"}


# ==================================================
# CUSTOM OPENAPI (SWAGGER CONFIG)
# ==================================================

def custom_openapi():
    """
    ✅ Hook to customize Swagger/OpenAPI

    Currently:
    - Returns default schema (safe)
    - Keeps future option open for JWT enhancements

    You can later inject:
    - Bearer auth config
    - Tags / descriptions
    - API grouping
    """

    if app.openapi_schema:
        return app.openapi_schema

    openapi_schema = get_openapi(
        title=app.title,
        version=app.version,
        routes=app.routes,
    )

    # ✅ OPTIONAL FUTURE IMPROVEMENT:
    # Add JWT Bearer auth to Swagger globally
    #
    # openapi_schema["components"]["securitySchemes"] = {
    #     "BearerAuth": {
    #         "type": "http",
    #         "scheme": "bearer",
    #         "bearerFormat": "JWT"
    #     }
    # }
    #
    # openapi_schema["security"] = [{"BearerAuth": []}]

    app.openapi_schema = openapi_schema
    return app.openapi_schema


# ✅ Attach custom OpenAPI function
app.openapi = custom_openapi


# ==========================================
# TEMPORARY TEST ROUTE
# Used to verify the FastAPI application is running correctly.
# Safe to remove once integration (OAuth / Graph API) is completed.
# ==========================================
@app.get("/copilot-test")
def copilot_test():
    return {"message": "Copilot test route working!"}


# ===============================
# IMPORTS
# ===============================

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.database import engine
from app import models


# ✅ Explicit router imports (best practice)
from app.routers.auth import router as auth_router
from app.routers.users import router as users_router
from app.routers.websocket import router as websocket_router
from app.routers.display import router as display_router



# ===============================
# CREATE FASTAPI APP
# ===============================

app = FastAPI(title="SherryJo App", version="1.0")

# ===============================
# DATABASE INITIALIZATION
# ===============================

models.Base.metadata.create_all(bind=engine)

# ===============================
# STATIC FILES (JS, CSS)
# ===============================

app.mount("/static", StaticFiles(directory="app/static"), name="static")


# ===============================
# TEMPLATE ENGINE (HTML)
# ===============================

templates = Jinja2Templates(directory="app/templates")


# ===============================
# ROUTERS (MODULAR API SYSTEM)
# ===============================

app.include_router(auth_router)
app.include_router(users_router)
app.include_router(websocket_router)
app.include_router(display_router)


# ===============================
# MAIN PAGE (UI ENTRY POINT)
# ===============================

@app.get("/")
def home(request: Request):
    return templates.TemplateResponse(
        "index.html",
        {"request": request}
    )


# ===============================
# HEALTH CHECK
# ===============================

@app.get("/health")
def health_check():
    return {"status": "ok", "app": "running"}
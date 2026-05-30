
from fastapi import FastAPI
from app.database import Base, engine
from app.routers import all_routes

app = FastAPI(title="SherryJo Calendar API")


@app.on_event("startup")
def startup():
    Base.metadata.create_all(bind=engine)


for r in all_routes:
    app.include_router(r)

@app.get("/")
def root():
    return {"message": "SherryJo Calendar API is running"}

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",   # path to your FastAPI app
        host="127.0.0.1",
        port=8000,
        reload=True       # auto-reload when you save files
    )

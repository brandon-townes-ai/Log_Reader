import asyncio
import os
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.staticfiles import StaticFiles

from .parser import parse_text, merge_and_sort, entries_to_json

app = FastAPI(title="Log Reader")

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/upload")
async def upload_logs(files: list[UploadFile] = File(...)):
    if not files:
        raise HTTPException(status_code=400, detail="No files provided")

    groups = []
    for f in files:
        raw = await f.read()
        try:
            text = raw.decode("utf-8", errors="replace")
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Could not decode {f.filename}: {exc}")
        # Run CPU-bound parsing off the event loop
        entries = await asyncio.to_thread(parse_text, text)
        groups.append(entries)

    merged = await asyncio.to_thread(merge_and_sort, groups)
    return entries_to_json(merged)


if FRONTEND_DIR.exists():
    # Must be mounted after all API routes so /health and /api/* take priority
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("src.server:app", host="0.0.0.0", port=port, reload=False)

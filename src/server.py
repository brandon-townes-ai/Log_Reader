import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Log Reader")

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

# Guard the analysis endpoint against pathologically large payloads (mirrors the
# core-stack BagReader limit). The UI posts the filtered view, not whole runs.
_MAX_PROCESS_ENTRIES = 200_000


@app.get("/health")
def health():
    return {"status": "ok"}


# ── Frontend-probed endpoints ────────────────────────────────────────────────
# This deployment is drag-drop only (no OCI/URSA acquisition), so report
# "unavailable"/"none" and the UI degrades to local file drop on its own.


@app.get("/api/status")
def api_status():
    return {
        "acquisition": "unavailable",
        "reason": "OCI acquisition is not configured on this deployment",
        "profile": "",
        "hostname": "",
    }


@app.get("/api/source")
def api_source():
    return {"type": "none", "arg": None}


@app.post("/api/process")
async def api_process(request: Request):
    """Analyze parsed log entries: returns {summary, triage}.

    Accepts {"entries": [...], "top": int?} -- the parsed records the frontend already
    holds (same field names as src/parser.LogEntry). CPU-bound work runs in the
    threadpool so the event loop stays free. No credentials needed.
    """
    from src.analyzer import summarize, triage

    body = await request.json()
    entries = body.get("entries", [])
    top = int(body.get("top", 20))
    if not isinstance(entries, list):
        return JSONResponse(
            status_code=400,
            content={"status": "error", "reason": "entries must be a list"},
        )
    if len(entries) > _MAX_PROCESS_ENTRIES:
        return JSONResponse(
            status_code=413,
            content={
                "status": "error",
                "reason": (
                    f"too many entries ({len(entries):,} > {_MAX_PROCESS_ENTRIES:,}); "
                    "narrow with level/process/search filters first"
                ),
            },
        )
    summary = await run_in_threadpool(summarize, entries, top)
    report = await run_in_threadpool(triage, entries, top)
    return {"summary": summary, "triage": report}


# Static frontend mounted LAST so /api/* and /health take precedence over the
# "/" catch-all.
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("src.server:app", host="0.0.0.0", port=port, reload=False)

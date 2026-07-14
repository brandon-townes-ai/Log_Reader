import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from src.backend import oci_source
from src.backend.auth import configure_ursa_env

app = FastAPI(title="Log Reader")

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

# Guard the analysis endpoint against pathologically large payloads (mirrors the
# core-stack BagReader limit). The UI posts the filtered view, not whole runs.
_MAX_PROCESS_ENTRIES = 200_000

# Configure URSA/OCI env once at startup (sets host + AWS profile defaults, logs
# whether a token is present). Never raises; drag-drop works with or without it.
configure_ursa_env()


@app.get("/health")
def health():
    return {"status": "ok"}


# ── Acquisition API ──────────────────────────────────────────────────────────
# The server holds one credential and fetches bags on behalf of anonymous users;
# there is no per-user login. When no token is configured, /api/status reports
# "unavailable" and the frontend degrades to drag-drop on its own.


@app.get("/api/status")
def api_status():
    """What the frontend polls on load to decide whether to show OCI controls."""
    p = oci_source.probe()
    return {
        "acquisition": "available" if p.get("available") else "unavailable",
        "reason": p.get("reason", ""),
        "profile": p.get("profile", ""),
        "hostname": p.get("hostname", ""),
    }


@app.get("/api/source")
def api_source():
    """No CLI-launched source in the hosted app; users paste a run-id/link."""
    return {"type": "none", "arg": None}


@app.get("/api/oci/logs")
def api_oci_logs(run_id: str):
    """Resolve a run-id/UUID/bag link and list its logs/ files."""
    p = oci_source.probe()
    if not p.get("available"):
        return JSONResponse(
            status_code=503,
            content={"status": "unavailable", "reason": p.get("reason", "")},
        )
    try:
        info, files = oci_source.list_logs(run_id)
    except oci_source.OciError as exc:
        return JSONResponse(
            status_code=404, content={"status": "error", "reason": str(exc)}
        )
    return {
        "run_uuid": info["uuid"],
        "custom_id": info["custom_id"],
        "files": [{"key": f.key, "name": f.name, "size": f.size} for f in files],
    }


@app.get("/api/oci/file")
def api_oci_file(run_id: str, key: str):
    """Stream a single log object as text/plain (key must belong to the run).

    Streamed (chunked) rather than buffered: Cloud Run rejects non-streamed
    responses over 32 MiB, and logs can be much larger. The temp file downloaded
    by fetch_log_to_path is deleted when the stream finishes.
    """
    p = oci_source.probe()
    if not p.get("available"):
        return JSONResponse(
            status_code=503,
            content={"status": "unavailable", "reason": p.get("reason", "")},
        )
    try:
        path = oci_source.fetch_log_to_path(run_id, key)
    except oci_source.OciError as exc:
        return JSONResponse(
            status_code=400, content={"status": "error", "reason": str(exc)}
        )

    def _stream():
        try:
            with open(path, "rb") as fh:
                while chunk := fh.read(1024 * 1024):
                    yield chunk
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    return StreamingResponse(
        _stream(),
        media_type="text/plain; charset=utf-8",
        headers={"X-Log-Name": os.path.basename(key)},
    )


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

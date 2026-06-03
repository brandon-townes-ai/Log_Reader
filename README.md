# [LOG_READER]

A drag-and-drop log analyzer for autonomous vehicle bag logs. Drop your `.txt` log files in, (or a whole folder!) get a fast interactive viewer — filter by level, search with regex, inspect entries, scrub the timeline.

Built by [brandon.townes@applied.co](https://anaheim.applied.co/anaheim/appliedistan/about?userId=brandon.townes)

---

## Features

- **Drag & drop** — drop a single file or an entire folder of `.txt` / `.log` files
- **Level filtering** — one-click filter for INFO, DEBUG, WARN, ERROR, FATAL, ALWAYS
- **Process filtering** — multi-select dropdown to isolate specific nodes
- **Regex search + exclude** — filter and anti-filter with full regex support
- **Timeline histogram** — visual log density over time; click or drag to set a time range
- **Collapse repeats** — fold consecutive identical messages into a single row
- **Entry inspector** — click any row for a full detail panel (timestamp, process, level, module, source, line #, message)
- **Client-side parsing** — all parsing happens in the browser via WebWorker; no file data leaves your machine
- **Fault monitor parsing** — auto-detects fault monitor tables (`ACTIVE FAULTS`, `FAULT EVENTS HISTORY`) and renders structured fields (severity, fault code, count, age, message)
- **ANSI stripping** — cleans up terminal color codes from raw log output
- **Light / dark mode**

---

## Running locally

```bash
# Install dependencies
make install

# Start the server (serves frontend at http://localhost:8000)
make run

# Dev mode with hot reload
make dev
```

Requires Python 3.11+.

---

## Deploying

```bash
make deploy
```

Uses `apps-platform` to deploy to Google Cloud Run. The server is a thin static file host — all parsing runs client-side, so there are no server timeouts or memory constraints tied to file size.

---

## Log format

Expects ROS-style `.txt` or `.log` files with entries in the format:

```
YYYY-MM-DD HH:MM:SS.ffffff[process][LEVEL][module][source] message
```

Multi-line entries (stack traces, health monitor tables, etc.) are automatically detected and attached to their parent entry. ANSI escape codes are stripped automatically.

---

## Stack

- **Frontend** — vanilla JS, HTML/CSS, Canvas API, WebWorker
- **Server** — FastAPI + uvicorn (static file serving only)
- **Fonts** — JetBrains Mono, Share Tech Mono

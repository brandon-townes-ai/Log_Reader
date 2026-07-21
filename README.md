# [LOG_READER]

A drag-and-drop log analyzer for autonomous vehicle bag logs. Drop your `.txt` log files in, (or a whole folder!) get a fast interactive viewer — filter by level, search with regex, inspect entries, scrub the timeline.

Built by [brandon.townes@applied.co](https://anaheim.applied.co/anaheim/appliedistan/about?userId=brandon.townes)

---

## Features

- **Drag & drop** — drop a single file, a folder of `.txt` / `.log` files, or a whole bag directory (subfolders like `logs/` are searched recursively; binary siblings such as `traces/`, `mcap/`, `can_data/` are ignored)
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

Requires Python 3.11+. Everything is driven through `make` — see the reference below.

### Make targets

| Target | What it does |
| --- | --- |
| `make install` | Create the `venv` (if needed) and install `requirements.txt`. |
| `make install-oci` | `install` **plus** `ursa-py` for OCI/URSA bag fetch. `ursa-py` lives on Applied's private index, so pass `URSA_PYPI_INDEX="https://<user>:<pass>@ursa.pypi.applied.dev/simple"` — credentials never land in git. |
| `make run` | Serve the frontend at `http://localhost:8000` (no hot reload). |
| `make dev` | Same as `run`, with `--reload` for hot reload. **Drag-drop only** — no OCI token, so the run-id / bag-link box is inactive. |
| `make cli` | Run the terminal log viewer: `make cli ARGS="<file\|dir> [--level L] [--search TXT] [--process NAME]"`. |
| `make image` | Build the deployable Docker image with `ursa-py` baked in. Needs `URSA_PYPI_INDEX` (passed as a BuildKit secret, never in git or image layers). |
| `make deploy` | Deploy the locally-built image to Cloud Run via `apps-platform`. |
| `make ship` | `image` + `deploy` in one step. |
| `make clean` | Remove `venv` and all `__pycache__` / `.pyc` files. |

### Local dev with OCI bag fetch

`make dev` starts the server **without** a URSA token, so it's drag-drop only. To
work the run-id / bag-link box locally, use the helper script instead:

```bash
./dev-oci.sh
```

It mints a URSA token from your local AWS SSO session, then starts the server
(`--reload`) with the token exported so the server can fetch bags. Requires
`make install-oci` to have run and a valid default AWS SSO session; if the token
can't be minted it falls back to drag-drop mode.

---

## Deploying

```bash
make ship        # build the OCI-enabled image + deploy in one step
# or individually:
make image       # build the image (needs URSA_PYPI_INDEX)
make deploy      # deploy the locally-built image
```

Uses `apps-platform` to deploy to Google Cloud Run. The server is a thin static file host — all parsing runs client-side, so there are no server timeouts or memory constraints tied to file size.

For the full OCI/URSA bag-fetch deploy (setting machine + OCI credentials, gating
access), see **[DEPLOY.md](DEPLOY.md)**. The one-time credential load is scripted in
`./setup-secrets.sh`.

---

## Log format

Expects ROS-style `.txt` or `.log` files with entries in the format:

```
YYYY-MM-DD HH:MM:SS.ffffff[process][LEVEL][module][source] message
```

Multi-line entries (stack traces, health monitor tables, etc.) are automatically detected and attached to their parent entry. ANSI escape codes are stripped automatically.

### Fault extraction

Diagnostic-system and fault-monitor dumps embedded in ordinary INFO log lines (`ERROR_DISENGAGE | REDSTONE_FAULT_P1_STANDARD | 11871 times | …`, active-fault table rows, `-> SYSTEM_COMMAND_DISENGAGE` transitions) are promoted to structured fault fields at parse time. The FAULTS dock tab auto-opens when a bag contains faults: a deduped, severity-ranked ledger — click a code to filter the log to it (`flt=` in deep links). Faults also render as severity ticks along the top of the timeline and as colored left edges on log rows, since their log level alone (INFO) would hide them. The pattern table lives in `frontend/faults.js` and `src/parser.py` — **the two `FAULT_PATTERNS` tables must stay textually identical**; `tests/test_faults.py` is the oracle. CLI: `python -m src.cli <logs> --faults`.

### Latency extraction

Messages containing durations (`took 12.3 ms`, `latency: 45ms`, `duration=0.012s`, `[LATENCY] tag=... 850us`, …) are tagged with a normalized `latency_tag` and a unit-normalized `latency_ms` at parse time. The pattern table lives in `frontend/latency.js` (browser) and `src/parser.py` (CLI) — **the two `LATENCY_PATTERNS` tables must stay textually identical**; `tests/test_latency.py` is the oracle when adding a new pattern. View per-tag stats with the LATENCY panel in the UI or `python -m src.cli <logs> --latency`.

### Signal overlays

Numeric time-series dropped alongside logs are overlaid on the timeline so telemetry (tracking error, CPU load, …) lines up with log activity. Supported formats, parsed in `frontend/signals.js`:

- **`.csv`** — `timestamp,signal,value` (header optional; two columns = `timestamp,value` with the filename as the signal name)
- **`.jsonl`** — `{"timestamp": …, "signal": …, "value": …}` per line (`time`/`t`, `name`/`metric`, `val`/`v` aliases accepted)
- **`.out`** — InfluxDB/telegraf line protocol (content-sniffed), e.g. the `*_telegraf_metrics.out` file recorded in every bag — signals named `measurement.field`

Timestamps may be ISO strings or epoch numbers in s/ms/µs/ns (auto-detected). The SIGNALS → OVERLAY pill opens a searchable stats panel; clicking a row overlays that signal on the timeline (up to 4, each normalized to its own min→max range). Overlaid signals are included in deep links (`sig=`).

### Tests

```
make test          # pytest + node --test
```

or manually: `pip install -r requirements-dev.txt && python -m pytest tests/` and `node --test tests/`.

---

## Stack

- **Frontend** — vanilla JS, HTML/CSS, Canvas API, WebWorker
- **Server** — FastAPI + uvicorn (static file serving only)
- **Fonts** — JetBrains Mono, Share Tech Mono

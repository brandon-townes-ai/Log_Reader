"""Log analysis over parsed entries: metrics/summaries + automated triage.

Shared by the CLI `process` subcommand and the web `/api/process` endpoint. Operates on
parsed log entries that may be `LogEntry` dataclasses (from parser.py, used by the CLI) or
plain dicts (from the browser, whose parser.worker.js produces the same field names). A
single implementation therefore serves both surfaces -- the parser stays where it is on
each side; only the analysis is shared.

Pure standard library (no new external deps).
"""

import re
from collections import Counter, defaultdict
from datetime import datetime

# Severity ordering for triage (higher = more urgent). Only these levels are triaged.
_SEVERITY_RANK = {"FATAL": 3, "ERROR": 2, "WARN": 1}
_TRIAGE_LEVELS = frozenset(_SEVERITY_RANK)

# Normalize a message into a stable signature so the same error recurring with varying
# numbers / addresses / paths collapses into a single finding. Applied in order.
_NORM_PATTERNS = [
    (re.compile(r"0x[0-9a-fA-F]+"), "0x?"),  # hex addresses
    (re.compile(r"/\S+"), "<path>"),  # absolute-ish paths
    (re.compile(r"\b\d+\.\d+\b"), "<n>"),  # floats
    (re.compile(r"\b\d+\b"), "<n>"),  # integers
    (re.compile(r"\s+"), " "),  # collapse whitespace
]

_TS_FMT = "%Y-%m-%d %H:%M:%S.%f"
_TS_FMT_NO_FRAC = "%Y-%m-%d %H:%M:%S"


def _get(entry, field: str, default=""):
    """Read a field from an entry that may be a dict or a LogEntry dataclass."""
    value = (
        entry.get(field, default)
        if isinstance(entry, dict)
        else getattr(entry, field, default)
    )
    return default if value is None else value


def _normalize(message: str) -> str:
    """Reduce a message to a recurrence signature (first line, placeholders, capped)."""
    sig = message.split("\n", 1)[0]
    for pattern, repl in _NORM_PATTERNS:
        sig = pattern.sub(repl, sig)
    return sig.strip()[:200]


def _parse_ts(ts: str):
    """Parse a log timestamp, tolerating nanosecond precision (more than %f's 6 digits)."""
    if not ts:
        return None
    try:
        if "." in ts:
            head, frac = ts.split(".", 1)
            frac = frac[:6].ljust(6, "0")  # %f accepts at most 6 digits
            return datetime.strptime(f"{head}.{frac}", _TS_FMT)
        return datetime.strptime(ts, _TS_FMT_NO_FRAC)
    except ValueError:
        return None


def _duration_s(first_ts: str, last_ts: str):
    a, b = _parse_ts(first_ts), _parse_ts(last_ts)
    if a is None or b is None:
        return None
    return round((b - a).total_seconds(), 3)


def summarize(entries, top: int = 10) -> dict:
    """Aggregate metrics over `entries`. Returns a JSON-serializable dict."""
    entries = list(entries)
    by_level = Counter(_get(e, "level") for e in entries)
    by_process = Counter(_get(e, "process") for e in entries)
    by_module = Counter(_get(e, "module") for e in entries)

    process_levels: dict[str, Counter] = defaultdict(Counter)
    for e in entries:
        process_levels[_get(e, "process")][_get(e, "level")] += 1

    timestamps = [ts for e in entries if (ts := _get(e, "timestamp"))]
    first_ts = min(timestamps) if timestamps else None
    last_ts = max(timestamps) if timestamps else None

    # Most frequent ERROR/WARN messages (by normalized signature).
    sig_count: Counter = Counter()
    sig_sample: dict[str, str] = {}
    for e in entries:
        if _get(e, "level") in _TRIAGE_LEVELS:
            sig = _normalize(_get(e, "message"))
            if not sig:
                continue
            sig_count[sig] += 1
            sig_sample.setdefault(sig, _get(e, "message").split("\n", 1)[0])

    return {
        "total": len(entries),
        "by_level": dict(by_level),
        "by_process": dict(by_process.most_common()),
        "by_module": dict(by_module.most_common(top)),
        "error_count": by_level.get("ERROR", 0) + by_level.get("FATAL", 0),
        "warn_count": by_level.get("WARN", 0),
        "first_ts": first_ts,
        "last_ts": last_ts,
        "duration_s": _duration_s(first_ts, last_ts),
        "process_levels": {p: dict(c) for p, c in process_levels.items()},
        "top_messages": [
            {"signature": sig, "count": n, "sample": sig_sample[sig]}
            for sig, n in sig_count.most_common(top)
        ],
    }


def triage(entries, top: int = 20) -> dict:
    """Cluster ERROR/FATAL/WARN entries into ranked findings. JSON-serializable."""
    clusters: dict[tuple, dict] = {}
    for e in entries:
        level = _get(e, "level")
        if level not in _TRIAGE_LEVELS:
            continue
        message = _get(e, "message")
        signature = _normalize(message) or (message[:80] or "(empty)")
        key = (level, signature)
        ts = _get(e, "timestamp")
        cluster = clusters.get(key)
        if cluster is None:
            clusters[key] = {
                "severity": level,
                "signature": signature,
                "count": 1,
                "processes": {_get(e, "process")},
                "modules": {_get(e, "module")},
                "first_ts": ts,
                "last_ts": ts,
                "sample_message": message.split("\n", 1)[0],
                "sample_line": _get(e, "line_number", 0),
            }
            continue
        cluster["count"] += 1
        cluster["processes"].add(_get(e, "process"))
        cluster["modules"].add(_get(e, "module"))
        if ts and (not cluster["first_ts"] or ts < cluster["first_ts"]):
            cluster["first_ts"] = ts
        if ts and (not cluster["last_ts"] or ts > cluster["last_ts"]):
            cluster["last_ts"] = ts

    findings = sorted(
        clusters.values(),
        key=lambda f: (_SEVERITY_RANK.get(f["severity"], 0), f["count"]),
        reverse=True,
    )
    for f in findings:
        f["processes"] = sorted(f["processes"])
        f["modules"] = sorted(f["modules"])

    return {
        "finding_count": len(findings),
        "fatal": sum(1 for f in findings if f["severity"] == "FATAL"),
        "error": sum(1 for f in findings if f["severity"] == "ERROR"),
        "warn": sum(1 for f in findings if f["severity"] == "WARN"),
        "findings": findings[:top],
    }

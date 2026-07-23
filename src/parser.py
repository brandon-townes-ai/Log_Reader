import re
from dataclasses import dataclass, asdict
from pathlib import Path

_ANSI_RE = re.compile(r'\x1b\[[0-9;]*[A-Za-z]|\[\d[0-9;]*m')

_ENTRY_RE = re.compile(
    r'^(?P<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)'
    r'\[(?P<process>[^\]]+)\]'
    r'\[(?P<level>[^\]]+)\]'
    r'\[(?P<module>[^\]]+)\]'
    r'(?:\[(?P<source>[^\]]*)\])?'
    r' ?(?P<message>.*)'
)


@dataclass
class LogEntry:
    timestamp: str
    process: str
    level: str
    module: str
    source: str | None
    message: str
    raw: str
    line_number: int
    is_continuation: bool
    file: str | None = None
    latency_ms: float | None = None
    latency_tag: str | None = None
    latency_pattern: str | None = None


# ── Latency extraction ────────────────────────────────────────
# Mirror of frontend/latency.js — the pattern strings must stay
# textually identical in both files.

_UNIT_TO_MS = {
    "ns": 1e-6, "us": 1e-3, "µs": 1e-3, "ms": 1, "s": 1000, "sec": 1000,
    "secs": 1000, "seconds": 1000, "min": 60000, "m": 60000,
}

# Ordered by specificity; first match wins.
LATENCY_PATTERNS = [
    {"name": "latency_tagged", "tag": 1, "value": 2, "unit": 3,
     "re": re.compile(r'\[LATENCY\]\s*(?:tag\s*[=:]\s*)?([\w.\/-]+)\D*?(\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s)\b', re.I)},
    # periodic component stats: "Component::method min: 0.6 ms, avg: 3.4 ms, std: ..." — avg is the sample
    {"name": "stats_avg", "tag": 1, "value": 2, "unit": 3,
     "re": re.compile(r'([\w.:\/-]+)\s+min:\s*\d+(?:\.\d+)?(?:e[+-]?\d+)?\s*(?:ns|us|µs|ms|s)\s*,\s*avg:\s*(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(ns|us|µs|ms|s)\b', re.I)},
    {"name": "took", "value": 1, "unit": 2,
     "re": re.compile(r'\btook\s+(\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s|sec|secs|seconds)\b', re.I)},
    {"name": "latency_kv", "value": 1, "unit": 2, "defaultUnit": "ms",
     "re": re.compile(r'\blatency\s*[:=]\s*(\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s)?\b', re.I)},
    # "… latency response: 45 ms." — one word between 'latency' and the value; explicit unit required
    {"name": "latency_phrase", "value": 1, "unit": 2,
     "re": re.compile(r'\blatency\s+\w+\s*[:=]\s*(\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s)\b', re.I)},
    {"name": "duration_kv", "value": 1, "unit": 2,
     "re": re.compile(r'\b(?:duration|dur|elapsed(?:_time)?)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s|sec|secs|seconds)\b', re.I)},
    {"name": "in_ms", "value": 1, "unit": 2,
     "re": re.compile(r'\b(?:completed|finished|done|processed|ran)\b.{0,40}?\bin\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds)\b', re.I)},
]

MAX_SANE_MS = 24 * 3600 * 1000  # durations beyond a day are false positives

_NUM_RE = re.compile(r'\d+(?:\.\d+)?')
_WS_RE = re.compile(r'\s+')


def normalize_latency_msg(msg: str) -> str:
    """Numbers → '#', whitespace collapsed, capped — so "took 12.3 ms"
    and "took 15.1 ms" derive the same tag."""
    return _WS_RE.sub(' ', _NUM_RE.sub('#', msg)).strip()[:64]


def extract_latency(entry: LogEntry) -> LogEntry:
    for pat in LATENCY_PATTERNS:
        m = pat["re"].search(entry.message)
        if not m:
            continue
        unit = (m.group(pat["unit"]) or pat.get("defaultUnit") or "").lower()
        factor = _UNIT_TO_MS.get(unit)
        if factor is None:
            continue
        ms = float(m.group(pat["value"])) * factor
        if not (ms == ms) or ms > MAX_SANE_MS:  # NaN or insane
            continue
        entry.latency_ms = ms
        entry.latency_tag = (
            m.group(pat["tag"]) if "tag" in pat
            else f"{entry.module}:{normalize_latency_msg(entry.message)}"
        )
        entry.latency_pattern = pat["name"]
        return entry
    return entry


def _percentile(sorted_vals: list[float], p: float) -> float:
    """Nearest-rank percentile on a pre-sorted list — must match frontend/latency.js."""
    n = len(sorted_vals)
    return sorted_vals[min(n - 1, int(p * n))]


def latency_stats(entries: list[LogEntry]) -> list[dict]:
    groups: dict[str, list[float]] = {}
    for e in entries:
        if e.latency_ms is None:
            continue
        groups.setdefault(e.latency_tag, []).append(e.latency_ms)
    stats = []
    for tag, vals in groups.items():
        vals.sort()
        n = len(vals)
        stats.append({
            "tag": tag,
            "count": n,
            "mean": sum(vals) / n,
            "p50": _percentile(vals, 0.5),
            "p95": _percentile(vals, 0.95),
            "max": vals[-1],
        })
    stats.sort(key=lambda s: s["p95"], reverse=True)
    return stats


def parse_line(line: str, line_number: int) -> LogEntry | None:
    line = _ANSI_RE.sub('', line)
    m = _ENTRY_RE.match(line)
    if not m:
        return None
    source = m.group("source") or None
    if source == ":":
        source = None
    level = m.group("level").upper()
    return LogEntry(
        timestamp=m.group("timestamp"),
        process=m.group("process"),
        level="WARN" if level == "WARNING" else level,
        module=m.group("module"),
        source=source,
        message=m.group("message").strip(),
        raw=line.rstrip(),
        line_number=line_number,
        is_continuation=False,
    )


def parse_text(text: str) -> list[LogEntry]:
    entries: list[LogEntry] = []
    last: LogEntry | None = None

    for i, line in enumerate(text.splitlines(), start=1):
        entry = parse_line(line, i)
        if entry:
            entries.append(entry)
            last = entry
        elif last is not None and line.strip():
            # continuation — append to previous entry's message
            cleaned = _ANSI_RE.sub('', line).rstrip()
            if cleaned.strip():
                last.message = (last.message + "\n" + cleaned).strip()

    for entry in entries:
        extract_latency(entry)
    return entries


def parse_file(path: str) -> list[LogEntry]:
    with open(path, "r", errors="replace") as f:
        entries = parse_text(f.read())
    name = Path(path).name
    for e in entries:
        e.file = name
    return entries


def entries_to_json(entries: list[LogEntry]) -> list[dict]:
    return [asdict(e) for e in entries]


def merge_and_sort(groups: list[list[LogEntry]]) -> list[LogEntry]:
    flat = [e for group in groups for e in group]
    flat.sort(key=lambda e: e.timestamp)
    return flat

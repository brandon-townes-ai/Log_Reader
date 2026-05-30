import re
from dataclasses import dataclass, asdict

_ANSI_RE = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')

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


def parse_line(line: str, line_number: int) -> LogEntry | None:
    line = _ANSI_RE.sub('', line)
    m = _ENTRY_RE.match(line)
    if not m:
        return None
    source = m.group("source") or None
    if source == ":":
        source = None
    return LogEntry(
        timestamp=m.group("timestamp"),
        process=m.group("process"),
        level=m.group("level").upper(),
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

    return entries


def parse_file(path: str) -> list[LogEntry]:
    with open(path, "r", errors="replace") as f:
        return parse_text(f.read())


def entries_to_json(entries: list[LogEntry]) -> list[dict]:
    return [asdict(e) for e in entries]


def merge_and_sort(groups: list[list[LogEntry]]) -> list[LogEntry]:
    flat = [e for group in groups for e in group]
    flat.sort(key=lambda e: e.timestamp)
    return flat

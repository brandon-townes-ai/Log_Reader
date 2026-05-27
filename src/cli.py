"""
Usage:
    python -m src.cli <file> [file2 ...] [--level LEVEL] [--search TEXT] [--process NAME]
"""
import argparse
import hashlib
import sys

from rich.console import Console
from rich.text import Text

from .parser import parse_file, merge_and_sort, LogEntry

console = Console()

# Palette for per-process coloring (cycles via hash)
_PROCESS_COLORS = [
    "bright_cyan", "bright_magenta", "bright_yellow",
    "bright_green", "bright_blue", "orange3",
    "deep_sky_blue1", "green3", "medium_orchid",
]

_LEVEL_STYLES: dict[str, str] = {
    "INFO":    "white",
    "DEBUG":   "green",
    "WARN":    "yellow",
    "WARNING": "yellow",
    "ERROR":   "red",
    "FATAL":   "bold bright_red",
    "ALWAYS":  "dim",
}


def _process_color(name: str) -> str:
    idx = int(hashlib.md5(name.encode()).hexdigest(), 16) % len(_PROCESS_COLORS)
    return _PROCESS_COLORS[idx]


def _render_entry(entry: LogEntry) -> Text:
    t = Text()
    t.append(entry.timestamp, style="dim")
    t.append(" ")
    t.append(f"[{entry.process}]", style=_process_color(entry.process))
    level_style = _LEVEL_STYLES.get(entry.level, "white")
    t.append(f"[{entry.level}]", style=level_style)
    t.append(f"[{entry.module}]", style="medium_purple3")
    if entry.source:
        t.append(f"[{entry.source}]", style="cyan3")
    t.append(" ")
    t.append(entry.message, style=level_style)
    return t


def main():
    parser = argparse.ArgumentParser(description="Color-coded ROS bag log viewer")
    parser.add_argument("files", nargs="+", help="Log file(s) to view")
    parser.add_argument("--level", help="Filter by log level (e.g. ERROR, WARN)")
    parser.add_argument("--search", help="Only show lines containing this text")
    parser.add_argument("--process", help="Only show lines from this process")
    args = parser.parse_args()

    groups = []
    for path in args.files:
        try:
            groups.append(parse_file(path))
        except FileNotFoundError:
            console.print(f"[red]File not found:[/red] {path}", err=True)
            sys.exit(1)

    entries = merge_and_sort(groups)

    if args.level:
        lvl = args.level.upper()
        entries = [e for e in entries if e.level == lvl]

    if args.process:
        entries = [e for e in entries if args.process.lower() in e.process.lower()]

    if args.search:
        needle = args.search.lower()
        entries = [e for e in entries if needle in e.message.lower() or needle in e.raw.lower()]

    if not entries:
        console.print("[dim]No matching log entries.[/dim]")
        return

    for entry in entries:
        console.print(_render_entry(entry))


if __name__ == "__main__":
    main()

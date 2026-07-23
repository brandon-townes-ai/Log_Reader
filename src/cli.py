"""
Usage:
    python -m src.cli <file|dir> [file2|dir2 ...] [--level LEVEL] [--search TEXT] [--process NAME] [--latency]
"""
import argparse
import hashlib
import sys
from pathlib import Path

from rich.console import Console
from rich.table import Table
from rich.text import Text

from .parser import parse_file, merge_and_sort, latency_stats, fault_stats, LogEntry

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


def collect_log_files(path: Path) -> list[Path]:
    """Recursively find .txt/.log files under a directory, so a bag root
    (with its logs/ subfolder) works as well as the logs/ folder itself.
    Binary siblings (traces/*.pbbin, mcap/, can_data/) don't match."""
    return sorted([*path.rglob("*.txt"), *path.rglob("*.log")])


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
    parser.add_argument("--latency", action="store_true",
                        help="Show per-tag latency statistics instead of the log stream")
    parser.add_argument("--faults", action="store_true",
                        help="Show a deduped fault summary instead of the log stream")
    args = parser.parse_args()

    # Expand any directory args to all .txt files inside them
    resolved = []
    for arg in args.files:
        p = Path(arg)
        if p.is_dir():
            txt_files = collect_log_files(p)
            if not txt_files:
                console.print(f"[yellow]No .txt/.log files found under:[/yellow] {arg}", err=True)
            resolved.extend(str(f) for f in txt_files)
        else:
            resolved.append(arg)

    groups = []
    for path in resolved:
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

    if args.faults:
        stats = fault_stats(entries)
        if not stats:
            console.print("[dim]No faults found.[/dim]")
            return
        sev_style = {"FATAL": "bold bright_red", "ERROR": "red", "WARN": "yellow", "INFO": "white"}
        table = Table(title="Faults by code")
        table.add_column("CODE", style="bright_cyan", overflow="fold")
        table.add_column("SEVERITY")
        table.add_column("LINES", justify="right")
        table.add_column("REPORTED", justify="right")
        table.add_column("FIRST", style="dim")
        table.add_column("LAST", style="dim")
        table.add_column("DETAIL", overflow="fold")
        for s in stats:
            table.add_row(
                s["code"],
                f'[{sev_style.get(s["severity"], "white")}]{s["severity"]}[/]',
                str(s["lines"]),
                str(s["reported_max"]) if s["reported_max"] else "—",
                s["first"][:19], s["last"][:19],
                s["detail"] or "",
            )
        console.print(table)
        return

    if args.latency:
        stats = latency_stats(entries)
        if not stats:
            console.print("[dim]No latency samples found.[/dim]")
            return
        table = Table(title="Latency by tag (ms)")
        table.add_column("TAG", style="bright_cyan", overflow="fold")
        table.add_column("COUNT", justify="right")
        table.add_column("MEAN", justify="right")
        table.add_column("P50", justify="right")
        table.add_column("P95", justify="right", style="yellow")
        table.add_column("MAX", justify="right", style="red")
        for s in stats:
            table.add_row(s["tag"], str(s["count"]), f'{s["mean"]:.2f}',
                          f'{s["p50"]:.2f}', f'{s["p95"]:.2f}', f'{s["max"]:.2f}')
        console.print(table)
        return

    if not entries:
        console.print("[dim]No matching log entries.[/dim]")
        return

    for entry in entries:
        console.print(_render_entry(entry))


if __name__ == "__main__":
    main()

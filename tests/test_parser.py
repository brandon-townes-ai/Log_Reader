from pathlib import Path

import pytest

from src.parser import parse_file

FIXTURE = Path(__file__).parent / "fixtures" / "sample_ros.log"


@pytest.fixture(scope="module")
def entries():
    return parse_file(str(FIXTURE))


def by_line(entries, n):
    return next(e for e in entries if e.line_number == n)


def test_entry_count(entries):
    assert len(entries) == 18


def test_basic_fields(entries):
    e = by_line(entries, 1)
    assert e.timestamp == "2026-07-01 10:00:00.100000"
    assert e.process == "planner"
    assert e.level == "INFO"
    assert e.module == "core"
    assert e.source == "main.cc:42"
    assert e.message == "Startup complete"


def test_warning_canonicalized_to_warn(entries):
    assert by_line(entries, 11).level == "WARN"


def test_continuation_folded_into_parent(entries):
    e = by_line(entries, 12)
    assert e.level == "ERROR"
    assert "Traceback (most recent call last):" in e.message
    assert "ValueError: timeout" in e.message


def test_ansi_stripped(entries):
    e = by_line(entries, 18)
    assert e.process == "colorproc"
    assert "\x1b" not in e.raw
    assert "\x1b" not in e.message


def test_file_stamped(entries):
    assert all(e.file == "sample_ros.log" for e in entries)

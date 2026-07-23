from pathlib import Path

import pytest

from src.parser import fault_stats, parse_file

FIXTURE = Path(__file__).parent / "fixtures" / "sample_ros.log"


@pytest.fixture(scope="module")
def entries():
    return parse_file(str(FIXTURE))


def by_line(entries, n):
    return next(e for e in entries if e.line_number == n)


# line_number → (fault_code, fault_severity, fault_count, fault_pattern)
EXPECTED = {
    22: ("REDSTONE_FAULT_P1_STANDARD", "ERROR", 11871, "diag_pipe"),        # ERROR_DISENGAGE | …
    23: ("REDSTONE_FAULT_P1_STANDARD", "WARN", 11867, "monitor_row"),       # origin column present
    24: ("REDSTONE_FAULT_P2_WARNING", "WARN", 1914, "monitor_row"),         # no origin column
    25: ("SYSTEM_COMMAND_DISENGAGE", "ERROR", None, "disengage_event"),
}

# traps: wrapped ACTIVE FAULTS header, column-header row, plus ordinary lines
NO_FAULT_LINES = [1, 2, 9, 11, 12, 19, 26, 27]


@pytest.mark.parametrize("line", sorted(EXPECTED))
def test_fault_extracted(entries, line):
    code, severity, count, pattern = EXPECTED[line]
    e = by_line(entries, line)
    assert e.fault_code == code
    assert e.fault_severity == severity
    assert e.fault_count == count
    assert e.fault_pattern == pattern


@pytest.mark.parametrize("line", NO_FAULT_LINES)
def test_no_false_positives(entries, line):
    e = by_line(entries, line)
    assert e.fault_code is None
    assert e.fault_severity is None


def test_fault_detail(entries):
    assert by_line(entries, 22).fault_detail == \
        "Fault: STACK_DRIVER_FAULT_CMD_TIMEOUT_PARK_BRAKE code: 0x926"


def test_fault_stats_grouping_and_sort(entries):
    stats = fault_stats(entries)
    assert [s["code"] for s in stats] == [
        "REDSTONE_FAULT_P1_STANDARD",   # ERROR (worst seen across its 2 lines), 2 lines
        "SYSTEM_COMMAND_DISENGAGE",     # ERROR, 1 line
        "REDSTONE_FAULT_P2_WARNING",    # WARN
    ]
    p1 = stats[0]
    assert p1["lines"] == 2
    assert p1["severity"] == "ERROR"      # diag ERROR beats monitor-row WARN
    assert p1["reported_max"] == 11871
    assert p1["first"] == "2026-07-01 10:00:01.900000"
    assert p1["last"] == "2026-07-01 10:00:02.000000"

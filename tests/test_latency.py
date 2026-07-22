from pathlib import Path

import pytest

from src.parser import LogEntry, latency_stats, parse_file

FIXTURE = Path(__file__).parent / "fixtures" / "sample_ros.log"


@pytest.fixture(scope="module")
def entries():
    return parse_file(str(FIXTURE))


def by_line(entries, n):
    return next(e for e in entries if e.line_number == n)


# line_number → (latency_ms, latency_tag, latency_pattern)
EXPECTED = {
    2: (12.3, "core:Planning cycle took # ms", "took"),
    3: (15.1, "core:Planning cycle took # ms", "took"),
    4: (45.0, "ctrl:control loop latency: #ms", "latency_kv"),
    5: (7.0, "ctrl:tick latency=#", "latency_kv"),  # unit-less → default ms
    6: (12.0, "lidar:scan processing duration=#s", "duration_kv"),
    7: (3400.0, "lidar:cloud registration elapsed #s", "duration_kv"),
    8: (0.85, "planner/replan", "latency_tagged"),
    # real-world shapes observed in mine_autonomy bag logs (adt_calltoload)
    19: (12.5, "FusionDetector::callback", "stats_avg"),
    20: (45.0, "global:Received bedrock latency response: # ms.", "latency_phrase"),
}

# incl. traps: port 8080, retry count = 12, topic named /latency_report
NO_LATENCY_LINES = [1, 9, 10, 11, 12, 16, 17, 18, 21]


@pytest.mark.parametrize("line", sorted(EXPECTED))
def test_latency_extracted(entries, line):
    ms, tag, pattern = EXPECTED[line]
    e = by_line(entries, line)
    assert e.latency_ms == pytest.approx(ms)
    assert e.latency_tag == tag
    assert e.latency_pattern == pattern


@pytest.mark.parametrize("line", NO_LATENCY_LINES)
def test_no_false_positives(entries, line):
    e = by_line(entries, line)
    assert e.latency_ms is None
    assert e.latency_tag is None
    assert e.latency_pattern is None


def _mk(ms, tag="t"):
    return LogEntry(
        timestamp="2026-07-01 10:00:00.000000", process="p", level="INFO",
        module="m", source=None, message="x", raw="x", line_number=1,
        is_continuation=False, latency_ms=ms, latency_tag=tag,
    )


def test_latency_stats_nearest_rank():
    entries = [_mk(v) for v in (40, 10, 30, 20)]
    (s,) = latency_stats(entries)
    assert s["count"] == 4
    assert s["mean"] == pytest.approx(25.0)
    assert s["p50"] == 30   # nearest-rank: sorted[int(0.5 * 4)]
    assert s["p95"] == 40   # sorted[min(3, int(0.95 * 4))]
    assert s["max"] == 40


def test_latency_stats_sorted_by_p95_desc():
    entries = [_mk(5, "fast"), _mk(500, "slow"), _mk(6, "fast")]
    stats = latency_stats(entries)
    assert [s["tag"] for s in stats] == ["slow", "fast"]


def test_latency_stats_skips_unsampled():
    assert latency_stats([_mk(None, None)]) == []

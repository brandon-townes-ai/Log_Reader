'use strict';

// ── Latency extraction ────────────────────────────────────────
// Shared between the parser worker (importScripts) and the main
// thread (script tag). Mirrored in src/parser.py — the pattern
// strings must stay textually identical in both files.

const UNIT_TO_MS = {
  ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1000, sec: 1000,
  secs: 1000, seconds: 1000, min: 60000, m: 60000,
};

// Ordered by specificity; first match wins.
// tag/value/unit are capture-group indices; defaultUnit applies when
// the unit group is optional and absent.
const LATENCY_PATTERNS = [
  { name: 'latency_tagged', tag: 1, value: 2, unit: 3,
    re: /\[LATENCY\]\s*(?:tag\s*[=:]\s*)?([\w.\/-]+)\D*?(\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s)\b/i },
  // periodic component stats: "Component::method min: 0.6 ms, avg: 3.4 ms, std: ..." — avg is the sample
  { name: 'stats_avg', tag: 1, value: 2, unit: 3,
    re: /([\w.:\/-]+)\s+min:\s*\d+(?:\.\d+)?(?:e[+-]?\d+)?\s*(?:ns|us|µs|ms|s)\s*,\s*avg:\s*(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(ns|us|µs|ms|s)\b/i },
  { name: 'took', value: 1, unit: 2,
    re: /\btook\s+(\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s|sec|secs|seconds)\b/i },
  { name: 'latency_kv', value: 1, unit: 2, defaultUnit: 'ms',
    re: /\blatency\s*[:=]\s*(\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s)?\b/i },
  // "… latency response: 45 ms." — one word between 'latency' and the value; explicit unit required
  { name: 'latency_phrase', value: 1, unit: 2,
    re: /\blatency\s+\w+\s*[:=]\s*(\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s)\b/i },
  { name: 'duration_kv', value: 1, unit: 2,
    re: /\b(?:duration|dur|elapsed(?:_time)?)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s|sec|secs|seconds)\b/i },
  { name: 'in_ms', value: 1, unit: 2,
    re: /\b(?:completed|finished|done|processed|ran)\b.{0,40}?\bin\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds)\b/i },
];

const MAX_SANE_MS = 24 * 3600 * 1000;  // durations beyond a day are false positives

// Numbers → '#', whitespace collapsed, capped — so "took 12.3 ms" and
// "took 15.1 ms" derive the same tag.
function normalizeLatencyMsg(msg) {
  return msg.replace(/\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').trim().slice(0, 64);
}

function extractLatency(entry) {
  for (const pat of LATENCY_PATTERNS) {
    const m = pat.re.exec(entry.message);
    if (!m) continue;
    const unit = (m[pat.unit] || pat.defaultUnit || '').toLowerCase();
    const factor = UNIT_TO_MS[unit];
    if (factor === undefined) continue;
    const ms = parseFloat(m[pat.value]) * factor;
    if (!isFinite(ms) || ms > MAX_SANE_MS) continue;
    entry.latency_ms = ms;
    entry.latency_tag = pat.tag !== undefined
      ? m[pat.tag]
      : entry.module + ':' + normalizeLatencyMsg(entry.message);
    entry.latency_pattern = pat.name;
    return entry;
  }
  return entry;
}

// Nearest-rank percentile on a pre-sorted array — must match src/parser.py.
function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function computeLatencyStats(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (e.latency_ms == null) continue;
    if (!groups.has(e.latency_tag)) groups.set(e.latency_tag, []);
    groups.get(e.latency_tag).push(e.latency_ms);
  }
  const stats = [];
  for (const [tag, vals] of groups) {
    vals.sort((a, b) => a - b);
    const n = vals.length;
    stats.push({
      tag,
      count: n,
      mean: vals.reduce((s, v) => s + v, 0) / n,
      p50: percentile(vals, 0.5),
      p95: percentile(vals, 0.95),
      max: vals[n - 1],
    });
  }
  stats.sort((a, b) => b.p95 - a.p95);
  return stats;
}

if (typeof module !== 'undefined') {
  module.exports = { UNIT_TO_MS, LATENCY_PATTERNS, MAX_SANE_MS,
    normalizeLatencyMsg, extractLatency, percentile, computeLatencyStats };
}

'use strict';

// ── Numeric signal ingestion ──────────────────────────────────
// Parses time-series files dropped alongside logs so telemetry
// (tracking error, CPU load, …) can be overlaid on the timeline.
// Three formats:
//   .csv    — timestamp,signal,value (header optional; 2-col = t,value)
//   .jsonl  — {"timestamp": …, "signal": …, "value": …} per line
//   .out    — InfluxDB/telegraf line protocol (content-sniffed)
// Loaded in both the parser worker (importScripts) and the page.

const MAX_SAMPLES_PER_FILE = 1_500_000;  // cap surfaced via `truncated`, never silent

// Accepts ISO strings ("2026-07-01 10:00:00.5") or epoch numbers in
// s / ms / µs / ns (detected by magnitude); returns epoch ms or null.
function coerceSignalTime(x) {
  if (typeof x === 'number' || /^\d+(\.\d+)?$/.test(String(x).trim())) {
    const n = Number(x);
    if (!isFinite(n)) return null;
    if (n > 1e17) return n / 1e6;   // ns
    if (n > 1e14) return n / 1e3;   // µs
    if (n > 1e11) return n;         // ms
    return n * 1000;                // s
  }
  const t = Date.parse(String(x).trim().replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

function _newCollector() {
  const groups = new Map();  // signal → {t: number[], v: number[]}
  let total = 0, truncated = false;
  return {
    add(signal, t, v) {
      if (t == null || !isFinite(v)) return true;
      if (total >= MAX_SAMPLES_PER_FILE) { truncated = true; return false; }
      let g = groups.get(signal);
      if (!g) { g = { t: [], v: [] }; groups.set(signal, g); }
      g.t.push(t); g.v.push(v);
      total++;
      return true;
    },
    result() {
      return {
        signals: [...groups].map(([signal, g]) => ({ signal, t: g.t, v: g.v })),
        truncated,
      };
    },
  };
}

const _TIME_COL = /^(timestamp|time|t)$/i;
const _SIG_COL  = /^(signal|name|metric|topic)$/i;
const _VAL_COL  = /^(value|val|v)$/i;

function parseSignalCsv(text, fallbackName) {
  const col = _newCollector();
  const lines = text.split('\n');
  let start = 0;
  let iT = 0, iS = 1, iV = 2, twoCol = false;

  const first = (lines[0] || '').trim();
  const headCells = first.split(',').map(c => c.trim());
  if (headCells.some(c => _TIME_COL.test(c))) {
    iT = headCells.findIndex(c => _TIME_COL.test(c));
    iS = headCells.findIndex(c => _SIG_COL.test(c));
    iV = headCells.findIndex(c => _VAL_COL.test(c));
    twoCol = iS < 0;
    if (iV < 0) iV = twoCol ? (iT === 0 ? 1 : 0) : 2;
    start = 1;
  } else if (headCells.length === 2) {
    twoCol = true;
    iV = 1;
  }

  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = line.split(',');
    const t = coerceSignalTime(cells[iT]);
    const sig = twoCol ? fallbackName : (cells[iS] || '').trim();
    const v = parseFloat(cells[iV]);
    if (!sig) continue;
    if (!col.add(sig, t, v)) break;
  }
  return col.result();
}

function parseSignalJsonl(text, fallbackName) {
  const col = _newCollector();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o;
    try { o = JSON.parse(trimmed); } catch { continue; }
    const t = coerceSignalTime(o.timestamp ?? o.time ?? o.t);
    const sig = String(o.signal ?? o.name ?? o.metric ?? fallbackName ?? '');
    const v = parseFloat(o.value ?? o.val ?? o.v);
    if (!sig) continue;
    if (!col.add(sig, t, v)) break;
  }
  return col.result();
}

// measurement[,tag=…] field=1.5[,field2=2i] 1784493515000000000
const _TELEGRAF_RE = /^([A-Za-z_][\w]*)(?:,(\S*?))? (\S+) (\d{10,19})$/;
const _TELEGRAF_NUM = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?i?$/;

function looksLikeTelegraf(text) {
  for (const line of text.slice(0, 4000).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return _TELEGRAF_RE.test(trimmed);
  }
  return false;
}

function parseTelegraf(text) {
  const col = _newCollector();
  outer:
  for (const line of text.split('\n')) {
    const m = _TELEGRAF_RE.exec(line.trim());
    if (!m) continue;
    const t = coerceSignalTime(Number(m[4]));
    for (const f of m[3].split(',')) {
      const eq = f.indexOf('=');
      if (eq < 1) continue;
      const raw = f.slice(eq + 1);
      if (!_TELEGRAF_NUM.test(raw)) continue;  // skip strings/bools
      const v = parseFloat(raw);               // trailing 'i' (ints) ignored by parseFloat
      if (!col.add(m[1] + '.' + f.slice(0, eq), t, v)) break outer;
    }
  }
  return col.result();
}

// Routing helper — which parser handles this file, if any
function signalParserFor(name, text) {
  const lower = (name || '').toLowerCase();
  const base = lower.replace(/\.[^.]+$/, '');
  if (lower.endsWith('.csv'))   return () => parseSignalCsv(text, base);
  if (lower.endsWith('.jsonl')) return () => parseSignalJsonl(text, base);
  if (lower.endsWith('.out') && looksLikeTelegraf(text)) return () => parseTelegraf(text);
  return null;
}

if (typeof module !== 'undefined') {
  module.exports = { MAX_SAMPLES_PER_FILE, coerceSignalTime, parseSignalCsv,
    parseSignalJsonl, parseTelegraf, looksLikeTelegraf, signalParserFor };
}

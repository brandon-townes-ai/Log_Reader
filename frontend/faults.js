'use strict';

// ── Fault extraction ──────────────────────────────────────────
// Diagnostic/fault-monitor dumps arrive embedded in ordinary INFO log
// lines (process_stdout passthrough), so level filters never surface
// them. This pass promotes them to structured fault fields.
// Shared between the parser worker (importScripts) and the page.
// Mirrored in src/parser.py — the pattern strings must stay textually
// identical in both files.

const FAULT_SEVERITY_RANK = { FATAL: 3, ERROR: 2, WARN: 1, INFO: 0 };

// Ordered by specificity; first match wins.
const FAULT_PATTERNS = [
  // "ERROR_DISENGAGE | REDSTONE_FAULT_P1_STANDARD | 11871 times | 2 min ago | Fault: … code: 0x926"
  { name: 'diag_pipe', severity: 1, code: 2, count: 3, detail: 5,
    re: /^([A-Z][A-Z_]*)\s*\|\s*([A-Z][A-Z0-9_]+)\s*\|\s*(\d+)\s*times\s*\|\s*(.+?)\s*\|\s*(.+)$/ },
  // "redstone_driver   REDSTONE_FAULT_P1_STANDARD   11867   2026-07-18 12:06:51   Fault: …"
  // (origin column is optional — P2 rows start with the code)
  { name: 'monitor_row', code: 2, count: 3, detail: 5,
    re: /^(?:([a-z]\w[\w.-]*)\s{2,})?([A-Z][A-Z0-9_]{3,})\s{2,}(\d+)\s{2,}(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s{2,}(\S.*)$/ },
  // "[SYSTEM] -> SYSTEM_COMMAND_DISENGAGE" — the moment autonomy dropped
  { name: 'disengage_event', code: 1,
    re: /->\s*(SYSTEM_COMMAND_DISENGAGE)\b/ },
];

function mapFaultSeverity(word) {
  const s = (word || '').toUpperCase();
  if (s.startsWith('FATAL')) return 'FATAL';
  if (s.startsWith('ERROR')) return 'ERROR';
  if (s.startsWith('WARN'))  return 'WARN';
  return 'INFO';
}

function extractFault(entry) {
  for (const pat of FAULT_PATTERNS) {
    const m = pat.re.exec(entry.message);
    if (!m) continue;
    entry.fault_code = m[pat.code];
    if (pat.name === 'diag_pipe')        entry.fault_severity = mapFaultSeverity(m[pat.severity]);
    else if (pat.name === 'monitor_row') entry.fault_severity = 'WARN';  // active-fault table carries no severity; stats take the max seen per code
    else                                 entry.fault_severity = 'ERROR';
    if (pat.count !== undefined) entry.fault_count = parseInt(m[pat.count], 10);
    entry.fault_detail = pat.detail !== undefined ? m[pat.detail].trim() : entry.message;
    entry.fault_pattern = pat.name;
    return entry;
  }
  return entry;
}

// Group per code; severity is the worst seen, timestamps use entry._t
// (epoch ms, present after loadViewer) when available.
function computeFaultStats(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!e.fault_code) continue;
    let g = groups.get(e.fault_code);
    if (!g) {
      g = { code: e.fault_code, severity: e.fault_severity, lines: 0,
            reportedMax: 0, firstT: null, lastT: null, detail: e.fault_detail };
      groups.set(e.fault_code, g);
    }
    g.lines++;
    if (FAULT_SEVERITY_RANK[e.fault_severity] > FAULT_SEVERITY_RANK[g.severity]) {
      g.severity = e.fault_severity;
    }
    if (e.fault_count != null && e.fault_count > g.reportedMax) g.reportedMax = e.fault_count;
    if (e._t != null) {
      if (g.firstT === null || e._t < g.firstT) g.firstT = e._t;
      if (g.lastT  === null || e._t > g.lastT)  g.lastT  = e._t;
    }
    g.detail = e.fault_detail;
  }
  const stats = [...groups.values()];
  stats.sort((a, b) =>
    (FAULT_SEVERITY_RANK[b.severity] - FAULT_SEVERITY_RANK[a.severity]) || (b.lines - a.lines));
  return stats;
}

if (typeof module !== 'undefined') {
  module.exports = { FAULT_PATTERNS, FAULT_SEVERITY_RANK, mapFaultSeverity,
    extractFault, computeFaultStats };
}

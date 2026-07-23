'use strict';

importScripts('/latency.js');
importScripts('/signals.js');
importScripts('/faults.js');

// ── ROS log parser ────────────────────────────────────────────
const ANSI_RE  = /\x1b\[[0-9;]*[A-Za-z]|\[\d[0-9;]*m/g;
const ENTRY_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\[([^\]]+)\]\[([^\]]+)\]\[([^\]]+)\](?:\[([^\]]*)\])? ?(.*)/;

function stripAnsi(line) {
  return line.replace(ANSI_RE, '');
}

function parseRosLine(line, lineNumber) {
  const cleaned = stripAnsi(line);
  const m = ENTRY_RE.exec(cleaned);
  if (!m) return null;

  let source = m[5] != null ? m[5] : null;
  if (source === ':' || source === '') source = null;

  const rawLevel = m[3].toUpperCase();
  return {
    timestamp:       m[1],
    process:         m[2],
    level:           rawLevel === 'WARNING' ? 'WARN' : rawLevel,
    module:          m[4],
    source:          source,
    message:         m[6].trim(),
    raw:             cleaned.trimEnd(),
    line_number:     lineNumber,
    is_continuation: false,
  };
}

function parseRosText(text) {
  const entries = [];
  let last = null;
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const entry = parseRosLine(lines[i], i + 1);
    if (entry) {
      entries.push(entry);
      last = entry;
    } else if (last !== null && lines[i].trim()) {
      const cleaned = stripAnsi(lines[i]).trimEnd();
      if (cleaned.trim()) {
        last.message = (last.message + '\n' + cleaned).trim();
      }
    }
  }
  return entries;
}

// ── Diagnostic system parser ──────────────────────────────────
const DIAG_BLOCK_RE = /={10,}\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+={10,}/g;
const DIAG_FAULT_RE = /^([\w]+)\s*\|\s*([\w_]+)\s*\|\s*(\d+)\s*times\s*(?:\|\s*(\d+)\s*sec ago\s*)?\|\s*(.+)$/;

function mapDiagLevel(severity) {
  const s = severity.toUpperCase();
  if (s.startsWith('FATAL'))  return 'FATAL';
  if (s.startsWith('ERROR'))  return 'ERROR';
  if (s.startsWith('WARN'))   return 'WARN';
  return 'INFO';
}

function parseDiagText(text) {
  const entries = [];
  const lines   = text.split('\n');

  // Split file into per-second blocks
  const blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const bm = /={10,}\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+={10,}/.exec(lines[i]);
    if (bm) {
      if (cur) blocks.push(cur);
      cur = { timestamp: bm[1], startLine: i + 1, lines: [] };
    } else if (cur) {
      cur.lines.push({ text: lines[i], lineNum: i + 1 });
    }
  }
  if (cur) blocks.push(cur);

  const SECTIONS_TO_PARSE = ['Full Run Faults', 'Recent Process Crashes', 'Recent Topics Degraded'];

  for (const block of blocks) {
    const ts = block.timestamp;

    // Collect content lines grouped by section
    const sections = {};  // section name → { lines: [], startLine }
    let section = null;

    for (const { text: line, lineNum } of block.lines) {
      const trimmed = line.trim();
      if (/^-{10,}$/.test(trimmed)) continue;

      const hm = /^([\w\s()]+):$/.exec(trimmed);
      if (hm) {
        section = hm[1];
        if (!sections[section]) sections[section] = { lines: [], startLine: lineNum };
        continue;
      }

      if (section && trimmed && sections[section]) {
        // Skip column header rows
        if (trimmed.startsWith('Composition Instance ID')) continue;
        sections[section].lines.push({ text: line, lineNum });
      }
    }

    // Emit one entry per fault/crash/topic line
    for (const name of SECTIONS_TO_PARSE) {
      const sec = sections[name];
      if (!sec || !sec.lines.length) continue;

      for (const { text: line, lineNum } of sec.lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (name === 'Full Run Faults') {
          const fm = DIAG_FAULT_RE.exec(trimmed);
          if (!fm) continue;
          const [, severity, faultCode, count, secAgo, msg] = fm;
          entries.push({
            timestamp:       ts,
            process:         'diagnostic_system',
            level:           mapDiagLevel(severity),
            module:          faultCode,
            source:          severity,
            count:           `${count}x`,
            age:             secAgo != null ? `${secAgo}s ago` : null,
            fault_message:   msg.trim(),
            message:         `${count}x${secAgo != null ? ` | ${secAgo}s ago` : ''} | ${msg.trim()}`,
            raw:             trimmed,
            line_number:     lineNum,
            is_continuation: false,
          });
        } else if (name.includes('Process Crashes')) {
          entries.push({
            timestamp:       ts,
            process:         trimmed,
            level:           'ERROR',
            module:          'process_crash',
            source:          'crashes',
            message:         `Process crashed: ${trimmed}`,
            raw:             trimmed,
            line_number:     lineNum,
            is_continuation: false,
          });
        } else if (name.includes('Topics Degraded')) {
          entries.push({
            timestamp:       ts,
            process:         'diagnostic_system',
            level:           'WARN',
            module:          'topic_degraded',
            source:          'topics',
            message:         trimmed,
            raw:             trimmed,
            line_number:     lineNum,
            is_continuation: false,
          });
        }
      }
    }
  }

  return entries;
}

// ── Fault monitor parser ──────────────────────────────────────
function parseFaultMonitorText(text) {
  const entries = [];
  const lines   = text.split('\n');

  const BARE_TS_RE    = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  const SECTION_RE    = /^={3,}\s+(.+?)\s+={3,}$/;
  const DIVIDER_RE    = /^-{5,}$/;
  const COL_HEADER_RE = /Composition Instance ID/;

  let blockTs  = null;
  let section  = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Bare timestamp line — start new block
    if (BARE_TS_RE.test(trimmed)) {
      blockTs = trimmed;
      section = null;
      continue;
    }

    // Section header e.g. ===== ACTIVE FAULTS =====
    const sm = SECTION_RE.exec(trimmed);
    if (sm) { section = sm[1]; continue; }

    // Skip dividers and column headers
    if (DIVIDER_RE.test(trimmed) || COL_HEADER_RE.test(trimmed) || !trimmed || !blockTs || !section) continue;

    // Split on 2+ spaces — safe because inner timestamps use single space
    const cols = trimmed.split(/\s{2,}/);

    if (section === 'ACTIVE FAULTS' && cols.length >= 3) {
      const [process, module_, duration, ...rest] = cols;
      const message = rest.join('  ');
      entries.push({
        timestamp:       blockTs,
        process,
        level:           'WARN',
        module:          module_,
        source:          'active_fault',
        message:         `[${duration}s active] ${message}`,
        raw:             trimmed,
        line_number:     i + 1,
        is_continuation: false,
      });
    } else if (section === 'FAULT EVENTS HISTORY' && cols.length >= 4) {
      const [process, module_, count, lastTs, ...rest] = cols;
      // Use last event timestamp if it looks like a datetime, else fall back to block ts
      const ts = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(lastTs) ? lastTs : blockTs;
      const message = rest.join('  ');
      entries.push({
        timestamp:       ts,
        process,
        level:           'WARN',
        module:          module_,
        source:          'fault_history',
        message:         `[${count}x] ${message}`,
        raw:             trimmed,
        line_number:     i + 1,
        is_continuation: false,
      });
    }
  }

  return entries;
}

// ── Format detection ──────────────────────────────────────────
// Anchored to line starts: fault-monitor/diagnostic dumps embedded inside
// ROS-prefixed lines (e.g. execution_manager's process_stdout passthrough)
// must NOT hijack routing for the whole file.
function isDiagnosticFormat(text) {
  return /^={10,}\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+={10,}/m.test(text.slice(0, 2000));
}

function isFaultMonitorFormat(text) {
  return /^===== ACTIVE FAULTS =====/m.test(text.slice(0, 2000));
}

// ── Worker entry point ────────────────────────────────────────
self.onmessage = async ({ data }) => {
  try {
    const text = await data.file.text();

    // Numeric signal files (.csv / .jsonl / telegraf .out) produce
    // time-series samples instead of log entries
    const signalParser = signalParserFor(data.file.name, text);
    if (signalParser) {
      const { signals, truncated } = signalParser();
      self.postMessage({ type: 'done', entries: [], signals, truncated });
      return;
    }

    const entries = isDiagnosticFormat(text)  ? parseDiagText(text)
                : isFaultMonitorFormat(text) ? parseFaultMonitorText(text)
                : parseRosText(text);
    for (const e of entries) { extractLatency(e); extractFault(e); }
    // Stream entries in chunks: structured-cloning a multi-GB log's entries
    // in one postMessage fails with "Data cannot be cloned, out of memory"
    const CHUNK = 50000;
    let i = 0;
    for (; i + CHUNK < entries.length; i += CHUNK) {
      self.postMessage({ type: 'chunk', entries: entries.slice(i, i + CHUNK) });
    }
    self.postMessage({ type: 'done', entries: entries.slice(i), signals: [], truncated: false });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

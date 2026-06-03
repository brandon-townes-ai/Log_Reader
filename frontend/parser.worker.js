'use strict';

const ANSI_RE   = /\x1b\[[0-9;]*[A-Za-z]|\[\d[0-9;]*m/g;
const ENTRY_RE  = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\[([^\]]+)\]\[([^\]]+)\]\[([^\]]+)\](?:\[([^\]]*)\])? ?(.*)/;

function stripAnsi(line) {
  return line.replace(ANSI_RE, '');
}

function parseLine(line, lineNumber) {
  const cleaned = stripAnsi(line);
  const m = ENTRY_RE.exec(cleaned);
  if (!m) return null;

  let source = m[5] != null ? m[5] : null;
  if (source === ':' || source === '') source = null;

  const rawLevel = m[3].toUpperCase();
  return {
    timestamp:        m[1],
    process:          m[2],
    level:            rawLevel === 'WARNING' ? 'WARN' : rawLevel,
    module:           m[4],
    source:           source,
    message:          m[6].trim(),
    raw:              cleaned.trimEnd(),
    line_number:      lineNumber,
    is_continuation:  false,
  };
}

function parseText(text) {
  const entries = [];
  let last = null;
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const entry = parseLine(lines[i], i + 1);
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

self.onmessage = async ({ data }) => {
  try {
    const text = await data.file.text();
    const entries = parseText(text);
    self.postMessage({ type: 'done', entries });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

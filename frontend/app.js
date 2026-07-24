'use strict';

// ── Theme ────────────────────────────────────────────────────
const MOON_SVG = `<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>`;
const SUN_SVG  = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`;

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const isSun = theme === 'light';
  ['upload-theme-icon','viewer-theme-icon'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = isSun ? SUN_SVG : MOON_SVG;
  });
  localStorage.setItem('log-reader-theme', theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'light' ? 'dark' : 'light');
}

// Apply saved theme immediately (before DOM ready to avoid flash)
applyTheme(localStorage.getItem('log-reader-theme') || 'dark');

// ── Version ──────────────────────────────────────────────────
const VERSION = 'v1.0.7';

// ── Constants ────────────────────────────────────────────────
const PROCESS_COLORS = [
  '#38bdf8','#f472b6','#facc15','#4ade80',
  '#818cf8','#fb923c','#34d399','#e879f9','#60a5fa'
];

const LEVEL_COLORS = {
  INFO:    '#94a3b8',
  DEBUG:   '#4ade80',
  WARN:    '#fbbf24',
  WARNING: '#fbbf24',
  ERROR:   '#f87171',
  FATAL:   '#ef4444',
  ALWAYS:  '#64748b',
};

const ROW_H   = 22;  // px — matches --row-h CSS var
const BUFFER  = 20;  // extra rows above/below viewport

// ── State ─────────────────────────────────────────────────────
let allEntries      = [];
let filteredEntries = [];
let displayRows     = [];     // [{entry, count, groupId?}] — what the scroller iterates
let activeLevels    = null;   // null = ALL; else Set<string>
let activeProcesses = null;   // null = ALL; else Set<string>
let searchRegex     = null;   // compiled RegExp | null
let excludeRegex    = null;   // compiled RegExp | null
let rangeStart      = null;   // epoch ms | null
let rangeEnd        = null;   // epoch ms | null
let collapseRepeats = false;
let expandedGroups  = new Set();
let tStart          = 0;      // dataset time bounds (epoch ms)
let tEnd            = 0;
let uploadedFiles   = [];
let latencyStats     = [];    // [{tag, count, mean, p50, p95, max}] from latency.js
let latencySamples   = [];    // entries with latency_ms, in timestamp order
let dockTab          = null;  // null | 'inspect' | 'latency' | 'signals' — open dock tab
let latencySortKey   = 'p95';
let latencySortDir   = -1;    // -1 desc, 1 asc
let activeLatencyTag = null;  // string | null
let selectedEntry    = null;  // entry shown in the inspector (for deep links)
let pendingHashState = null;  // parsed URL-hash state, applied on next load
let laneMode         = null;  // null | 'proc' | 'file' — timeline lane rendering
let clockSkew        = [];    // [{file, offsetMs, tMin, tMax}] flagged by detectClockSkew
let signalData       = new Map();  // signal name → {t:[], v:[], min, max}
let signalStats      = [];    // [{name, count, min, mean, max}] for the panel
let activeSignals    = [];    // names overlaid on the timeline (≤ MAX_ACTIVE_SIGNALS)
let signalsSortKey   = 'count';
let signalsSortDir   = -1;
let signalsFilter    = '';
let signalsTruncated = false; // a file hit the per-file sample cap
let faultStats       = [];    // [{code, severity, lines, reportedMax, firstT, lastT, detail}]
let faultSamples     = [];    // entries with fault_code, in timestamp order
let activeFaultCode  = null;  // string | null — FAULTS panel row filter
let faultsSortKey    = 'severity';
let faultsSortDir    = -1;

// ── Utilities ────────────────────────────────────────────────
function hashColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return PROCESS_COLORS[Math.abs(h) % PROCESS_COLORS.length];
}

function esc(str) {
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// WARNING and WARN are the same severity; canonicalize so filters/pills line up
function canonLevel(lv) { return lv === 'WARNING' ? 'WARN' : lv; }

function compileRegex(raw, wrap) {
  if (!raw.trim()) {
    wrap?.classList.remove('regex-error');
    return null;
  }
  try {
    const r = new RegExp(raw, 'i');
    wrap?.classList.remove('regex-error');
    return r;
  } catch {
    wrap?.classList.add('regex-error');
    return null;
  }
}

function highlight(rawText, regex) {
  if (!regex) return esc(rawText);
  // Build a global version of the regex to find all matches
  const g = new RegExp(regex.source, regex.flags.replace('g', '') + 'g');
  const parts = []; let last = 0, m;
  while ((m = g.exec(rawText)) !== null) {
    parts.push(esc(rawText.slice(last, m.index)));
    parts.push(`<mark>${esc(m[0])}</mark>`);
    last = m.index + m[0].length;
    if (m[0].length === 0) g.lastIndex++; // guard: skip zero-length matches
  }
  parts.push(esc(rawText.slice(last)));
  return parts.join('');
}

// ── Virtual Scroller ──────────────────────────────────────────
let rafId         = null;
let renderedStart = 0;
let renderedEnd   = 0;
let rowsDirty     = false;  // true when displayRows content changed — forces full rebuild

function scheduleRender() {
  if (!rafId) rafId = requestAnimationFrame(() => { rafId = null; renderRows(); });
}

function renderRows() {
  const container = document.getElementById('log-container');
  const spacerTop = document.getElementById('spacer-top');
  const spacerBot = document.getElementById('spacer-bottom');
  const rowsEl    = document.getElementById('log-rows');
  const emptyMsg  = document.getElementById('empty-msg');

  const total = displayRows.length;

  emptyMsg.classList.toggle('hidden', total > 0 || allEntries.length === 0);

  if (total === 0) {
    spacerTop.style.height = '0';
    spacerBot.style.height = '0';
    rowsEl.textContent = '';
    renderedStart = renderedEnd = 0;
    rowsDirty = false;
    document.getElementById('timeline-cursor')?.classList.add('hidden');
    return;
  }

  const scrollTop    = container.scrollTop;
  const clientHeight = container.clientHeight;
  const newStart = Math.max(0,     Math.floor(scrollTop / ROW_H) - BUFFER);
  const newEnd   = Math.min(total, Math.ceil((scrollTop + clientHeight) / ROW_H) + BUFFER);

  // Update timeline scroll cursor
  const cursor = document.getElementById('timeline-cursor');
  if (cursor && displayRows.length && tEnd > tStart) {
    const midIdx = Math.min(Math.floor((newStart + newEnd) / 2), displayRows.length - 1);
    const t = displayRows[midIdx].entry._t;
    const ratio = Math.max(0, Math.min(1, (t - tStart) / (tEnd - tStart)));
    const barEl = document.getElementById('timeline-bar');
    cursor.style.left = Math.round(ratio * barEl.clientWidth) + 'px';
    cursor.classList.remove('hidden');
  } else if (cursor) {
    cursor.classList.add('hidden');
  }

  spacerTop.style.height = `${newStart * ROW_H}px`;
  spacerBot.style.height = `${(total - newEnd) * ROW_H}px`;

  const noOverlap = newEnd <= renderedStart || newStart >= renderedEnd;

  if (rowsDirty || noOverlap) {
    // Full rebuild — data changed or viewport jumped past rendered range
    rowsDirty = false;
    const frag = document.createDocumentFragment();
    for (let i = newStart; i < newEnd; i++) frag.appendChild(buildRow(displayRows[i], i));
    rowsEl.textContent = '';
    rowsEl.appendChild(frag);
    renderedStart = newStart;
    renderedEnd   = newEnd;
    return;
  }

  // Incremental update — only touch rows entering/leaving the viewport
  while (renderedStart < newStart && rowsEl.firstChild) {
    rowsEl.removeChild(rowsEl.firstChild);
    renderedStart++;
  }
  while (renderedEnd > newEnd && rowsEl.lastChild) {
    rowsEl.removeChild(rowsEl.lastChild);
    renderedEnd--;
  }
  if (newStart < renderedStart) {
    const frag = document.createDocumentFragment();
    for (let i = newStart; i < renderedStart; i++) frag.appendChild(buildRow(displayRows[i], i));
    rowsEl.insertBefore(frag, rowsEl.firstChild);
    renderedStart = newStart;
  }
  if (newEnd > renderedEnd) {
    const frag = document.createDocumentFragment();
    for (let i = renderedEnd; i < newEnd; i++) frag.appendChild(buildRow(displayRows[i], i));
    rowsEl.appendChild(frag);
    renderedEnd = newEnd;
  }
}

function buildRow(row, idx) {
  const entry = row.entry;
  const div = document.createElement('div');
  div.className = `log-row ${idx % 2 === 0 ? 'row-even' : 'row-odd'}`;
  div.dataset.i = idx;
  if (row.count > 1) div.classList.add('is-group');

  const lvlColor  = LEVEL_COLORS[entry.level] || '#94a3b8';
  const procColor = hashColor(entry.process);
  const isFatal   = entry.level === 'FATAL';
  if (entry.fault_severity) div.classList.add('fault-' + entry.fault_severity.toLowerCase());

  let html = `<span class="tok-ts">${esc(entry.timestamp)}</span>`;
  html += ` <span class="tok-proc" style="color:${procColor}">[${esc(entry.process)}]</span>`;
  html += `<span class="tok-lvl${isFatal ? ' lvl-fatal' : ''}" style="color:${lvlColor}">[${esc(entry.level)}]</span>`;
  html += `<span class="tok-mod">[${esc(entry.module)}]</span>`;
  if (entry.source) html += `<span class="tok-src">[${esc(entry.source)}]</span>`;
  html += `<span class="tok-msg" style="color:${lvlColor}">${highlight(entry.message, searchRegex)}</span>`;
  if (row.count > 1) html += `<span class="dup-badge" data-group="${row.groupId}">×${row.count} ⊕</span>`;

  div.innerHTML = html;
  return div;
}

// Transform filteredEntries → displayRows, folding consecutive identical runs when enabled
function buildDisplayRows() {
  displayRows = [];
  rowsDirty = true;
  if (!collapseRepeats) {
    for (const e of filteredEntries) displayRows.push({ entry: e, count: 1 });
    return;
  }
  let i = 0, gid = 0;
  while (i < filteredEntries.length) {
    const e = filteredEntries[i];
    let j = i + 1;
    while (j < filteredEntries.length &&
           filteredEntries[j].process === e.process &&
           filteredEntries[j].level   === e.level &&
           filteredEntries[j].message === e.message) j++;
    const count = j - i;
    if (count > 1) {
      const groupId = `g${gid++}`;
      if (expandedGroups.has(groupId)) {
        for (let k = i; k < j; k++) displayRows.push({ entry: filteredEntries[k], count: 1 });
      } else {
        displayRows.push({ entry: e, count, groupId });
      }
    } else {
      displayRows.push({ entry: e, count: 1 });
    }
    i = j;
  }
}

// ── Deep links (URL hash) ────────────────────────────────────
// The hash encodes view state only — files are local, so a deep link
// applies once the same bag is dropped again. Keys referencing absent
// data are silently ignored.
function serializeHash() {
  if (!allEntries.length) return;
  const p = new URLSearchParams();
  p.set('v', '1');
  if (activeLevels !== null)    p.set('lv', [...activeLevels].join(','));
  if (activeProcesses !== null) p.set('pr', [...activeProcesses].map(encodeURIComponent).join(','));
  const q = document.getElementById('search-input').value;
  const x = document.getElementById('exclude-input').value;
  if (q.trim()) p.set('q', q);
  if (x.trim()) p.set('x', x);
  if (collapseRepeats) p.set('col', '1');
  if (rangeStart !== null) {
    p.set('t0', Math.round(rangeStart));
    p.set('t1', Math.round(rangeEnd));
  }
  if (selectedEntry) p.set('sel', `${encodeURIComponent(selectedEntry.file ?? '')}~${selectedEntry.line_number}`);
  if (activeLatencyTag !== null) p.set('lat', activeLatencyTag);
  if (activeFaultCode !== null) p.set('flt', activeFaultCode);
  if (activeSignals.length) p.set('sig', activeSignals.map(encodeURIComponent).join(','));
  const str = p.toString();
  history.replaceState(null, '', str === 'v=1' ? location.pathname + location.search : '#' + str);
}

function parseHash() {
  if (location.hash.length < 2) return null;
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('v') !== '1') return null;
  const st = {};
  if (p.has('lv')) st.levels = p.get('lv').split(',').filter(Boolean);
  if (p.has('pr')) st.processes = p.get('pr').split(',').filter(Boolean).map(decodeURIComponent);
  if (p.has('q')) st.q = p.get('q');
  if (p.has('x')) st.x = p.get('x');
  st.col = p.get('col') === '1';
  if (p.has('t0') && p.has('t1')) { st.t0 = +p.get('t0'); st.t1 = +p.get('t1'); }
  if (p.has('sel')) {
    const raw = p.get('sel'), i = raw.lastIndexOf('~');
    if (i > -1) st.sel = { file: decodeURIComponent(raw.slice(0, i)), line: +raw.slice(i + 1) };
  }
  if (p.has('lat')) st.lat = p.get('lat');
  if (p.has('flt')) st.flt = p.get('flt');
  if (p.has('sig')) st.sig = p.get('sig').split(',').filter(Boolean).map(decodeURIComponent);
  return st;
}

function applyHashState(st) {
  if (st.levels) {
    const valid = st.levels.map(canonLevel).filter(lv => lv in LEVEL_COLORS);
    if (valid.length) { activeLevels = new Set(valid); syncLevelPills(); }
  }
  if (st.processes) {
    const present = new Set(allEntries.map(e => e.process));
    const valid = st.processes.filter(pr => present.has(pr));
    if (valid.length) buildProcessDropdown(new Set(valid));
  }
  if (st.q) {
    const input = document.getElementById('search-input');
    input.value = st.q;
    searchRegex = compileRegex(st.q, input.closest('.search-wrap'));
  }
  if (st.x) {
    const input = document.getElementById('exclude-input');
    input.value = st.x;
    excludeRegex = compileRegex(st.x, input.closest('.search-wrap'));
  }
  if (st.col) {
    collapseRepeats = true;
    const btn = document.getElementById('collapse-toggle');
    btn.classList.add('active');
    btn.setAttribute('aria-pressed', 'true');
  }
  if (st.t0 != null && st.t1 != null && st.t1 > st.t0 && st.t0 <= tEnd && st.t1 >= tStart) {
    rangeStart = Math.max(tStart, st.t0);
    rangeEnd   = Math.min(tEnd, st.t1);
    showRangeReadout();
  }
  if (st.lat && latencyStats.some(s => s.tag === st.lat)) {
    activeLatencyTag = st.lat;
    openDock('latency');
  }
  if (st.flt && faultStats.some(f => f.code === st.flt)) {
    activeFaultCode = st.flt;
    openDock('faults');
  }
  if (st.sig) activeSignals = st.sig.filter(n => signalData.has(n)).slice(0, MAX_ACTIVE_SIGNALS);

  applyFilters();

  if (st.sel) {
    const idx = displayRows.findIndex(r =>
      (r.entry.file ?? '') === st.sel.file && r.entry.line_number === st.sel.line);
    if (idx >= 0) {
      document.getElementById('log-container').scrollTop = idx * ROW_H;
      openInspector(displayRows[idx].entry);
    }
  }
}

// ── Filters ──────────────────────────────────────────────────
function applyFilters() {
  expandedGroups.clear();  // group ids shift when the filtered set changes

  filteredEntries = allEntries.filter(e => {
    if (activeLevels    !== null && !activeLevels.has(canonLevel(e.level))) return false;
    if (activeProcesses !== null && !activeProcesses.has(e.process))        return false;
    if (activeLatencyTag !== null && e.latency_tag !== activeLatencyTag)    return false;
    if (activeFaultCode !== null && e.fault_code !== activeFaultCode)       return false;
    if (rangeStart !== null && (e._t < rangeStart || e._t > rangeEnd))      return false;
    if (searchRegex  && !searchRegex.test(e.raw))  return false;
    if (excludeRegex &&  excludeRegex.test(e.raw)) return false;
    return true;
  });

  buildDisplayRows();
  updateResultCount();
  renderScrollMarkers();
  document.getElementById('log-container').scrollTop = 0;
  renderRows();
  serializeHash();
}

function toggleLevel(lv) {
  if (lv === 'ALL') {
    activeLevels = null;
  } else if (activeLevels === null) {
    activeLevels = new Set([lv]);
  } else {
    activeLevels.has(lv) ? activeLevels.delete(lv) : activeLevels.add(lv);
    if (activeLevels.size === 0) activeLevels = null;
  }
  syncLevelPills();
  applyFilters();
}

function updateResultCount() {
  const el = document.getElementById('result-count');
  el.textContent = filteredEntries.length < allEntries.length
    ? `${filteredEntries.length.toLocaleString()} / ${allEntries.length.toLocaleString()} shown`
    : '';
}

// ── Time helpers ─────────────────────────────────────────────
function fmtClock(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m ${sec}s` : m ? `${m}m ${sec}s` : `${sec}s`;
}

// Human-friendly duration for latency values
function fmtMs(ms) {
  if (ms >= 1000) return (ms / 1000).toFixed(2) + 's';
  if (ms >= 1)    return ms.toFixed(ms >= 100 ? 0 : 1) + 'ms';
  return (ms * 1000).toFixed(0) + 'µs';
}

// ── Latency panel ────────────────────────────────────────────
function renderLatencyPanel() {
  if (dockTab !== 'latency') return;

  const dir = latencySortDir;
  const rows = [...latencyStats].sort((a, b) => {
    const va = a[latencySortKey], vb = b[latencySortKey];
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
  });

  const cols = [['tag','TAG'],['count','COUNT'],['mean','MEAN'],['p50','P50'],['p95','P95'],['max','MAX']];
  let html = '<table class="latency-table"><thead><tr>';
  for (const [key, label] of cols) {
    const arrow = key === latencySortKey ? (dir < 0 ? ' ▾' : ' ▴') : '';
    html += `<th data-sort="${key}"${key === 'tag' ? ' class="lat-col-tag"' : ''}>${label}${arrow}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (const s of rows) {
    html += `<tr data-tag="${esc(s.tag)}"${s.tag === activeLatencyTag ? ' class="active"' : ''}>` +
      `<td class="lat-col-tag">${esc(s.tag)}</td>` +
      `<td>${s.count.toLocaleString()}</td>` +
      `<td>${fmtMs(s.mean)}</td><td>${fmtMs(s.p50)}</td><td>${fmtMs(s.p95)}</td><td>${fmtMs(s.max)}</td></tr>`;
  }
  html += '</tbody></table>';
  document.getElementById('latency-table-wrap').innerHTML = html;
}

// ── Signals panel + overlay ──────────────────────────────────
const SIGNAL_COLORS = ['#38bdf8', '#e879f9', '#4ade80', '#fb923c'];
const MAX_ACTIVE_SIGNALS = SIGNAL_COLORS.length;

function fmtSigVal(v) {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 1)   return String(+v.toFixed(2));
  return v === 0 ? '0' : v.toPrecision(3);
}

function renderSignalsPanel() {
  if (dockTab !== 'signals') return;

  const q = signalsFilter.toLowerCase();
  const rows = signalStats
    .filter(s => !q || s.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const va = a[signalsSortKey], vb = b[signalsSortKey];
      return (va < vb ? -1 : va > vb ? 1 : 0) * signalsSortDir;
    });

  const cols = [['name','SIGNAL'],['count','COUNT'],['min','MIN'],['mean','MEAN'],['max','MAX']];
  let html = '<table class="latency-table"><thead><tr>';
  for (const [key, label] of cols) {
    const arrow = key === signalsSortKey ? (signalsSortDir < 0 ? ' ▾' : ' ▴') : '';
    html += `<th data-sort="${key}"${key === 'name' ? ' class="lat-col-tag"' : ''}>${label}${arrow}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (const s of rows) {
    const ai = activeSignals.indexOf(s.name);
    html += `<tr data-sig="${esc(s.name)}"${ai >= 0 ? ' class="active"' : ''}>` +
      `<td class="lat-col-tag"><span class="sig-dot" style="background:${ai >= 0 ? SIGNAL_COLORS[ai] : 'transparent'}"></span>${esc(s.name)}</td>` +
      `<td>${s.count.toLocaleString()}</td>` +
      `<td>${fmtSigVal(s.min)}</td><td>${fmtSigVal(s.mean)}</td><td>${fmtSigVal(s.max)}</td></tr>`;
  }
  html += '</tbody></table>';
  document.getElementById('signals-table-wrap').innerHTML = html;
}

function toggleSignalOverlay(name) {
  const i = activeSignals.indexOf(name);
  if (i >= 0) activeSignals.splice(i, 1);
  else {
    activeSignals.push(name);
    if (activeSignals.length > MAX_ACTIVE_SIGNALS) activeSignals.shift();
  }
  renderSignalsPanel();
  renderTimeline();
  serializeHash();
}

// Per-pixel min/max strips, each signal normalized to its own [min, max] —
// units differ, so shapes (spikes, trends) are what's comparable, not scale
function drawSignalOverlay(ctx, w, h) {
  if (!activeSignals.length || tEnd <= tStart) return;
  const span = tEnd - tStart;
  const nb = Math.max(1, Math.floor(w));
  ctx.font = '9px "JetBrains Mono", monospace';
  ctx.textBaseline = 'top';

  activeSignals.forEach((name, idx) => {
    const g = signalData.get(name);
    if (!g || !g.t.length) return;
    const color = SIGNAL_COLORS[idx];
    const range = (g.max - g.min) || 1;
    const mins = new Float64Array(nb).fill(Infinity);
    const maxs = new Float64Array(nb).fill(-Infinity);
    for (let i = 0; i < g.t.length; i++) {
      let b = Math.floor(((g.t[i] - tStart) / span) * nb);
      if (b < 0) b = 0; else if (b >= nb) b = nb - 1;
      const v = g.v[i];
      if (v < mins[b]) mins[b] = v;
      if (v > maxs[b]) maxs[b] = v;
    }
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < nb; i++) {
      if (mins[i] === Infinity) continue;
      const yLo = h - 3 - ((mins[i] - g.min) / range) * (h - 8);
      const yHi = h - 3 - ((maxs[i] - g.min) / range) * (h - 8);
      ctx.moveTo(i + 0.5, yLo);
      ctx.lineTo(i + 0.5, Math.min(yHi, yLo - 1));  // ≥1px so flat stretches stay visible
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    const label = `${name} [${fmtSigVal(g.min)}…${fmtSigVal(g.max)}]`;
    const tw = (ctx.measureText(label) || { width: label.length * 6 }).width;
    ctx.fillText(label, Math.max(4, w - tw - 6), 3 + idx * 10);
  });
}

// ── Faults panel ─────────────────────────────────────────────
function renderFaultsPanel() {
  if (dockTab !== 'faults') return;

  const dir = faultsSortDir;
  const rows = [...faultStats].sort((a, b) => {
    let va, vb;
    if (faultsSortKey === 'severity') {
      va = FAULT_SEVERITY_RANK[a.severity]; vb = FAULT_SEVERITY_RANK[b.severity];
    } else {
      va = a[faultsSortKey]; vb = b[faultsSortKey];
    }
    const cmp = (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    return cmp !== 0 ? cmp : b.lines - a.lines;
  });

  const cols = [['severity','SEV'],['code','CODE'],['lines','LINES'],['reportedMax','REPORTED'],['lastT','LAST SEEN'],['detail','DETAIL']];
  let html = '<table class="latency-table"><thead><tr>';
  for (const [key, label] of cols) {
    const arrow = key === faultsSortKey ? (dir < 0 ? ' ▾' : ' ▴') : '';
    html += `<th data-sort="${key}"${key === 'detail' ? ' class="lat-col-tag"' : ''}>${label}${arrow}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (const f of rows) {
    const color = LEVEL_COLORS[f.severity] || LEVEL_COLORS.ERROR;
    html += `<tr data-flt="${esc(f.code)}"${f.code === activeFaultCode ? ' class="active"' : ''}>` +
      `<td><span class="sig-dot" style="background:${color};border-color:${color}"></span>${f.severity}</td>` +
      `<td class="flt-code">${esc(f.code)}</td>` +
      `<td>${f.lines.toLocaleString()}</td>` +
      `<td>${f.reportedMax ? f.reportedMax.toLocaleString() + '×' : '—'}</td>` +
      `<td>${f.lastT != null ? fmtClock(f.lastT) : '—'}</td>` +
      `<td class="lat-col-tag flt-detail">${esc(f.detail || '')}</td></tr>`;
  }
  html += '</tbody></table>';
  document.getElementById('faults-table-wrap').innerHTML = html;
}

function selectFaultCode(code) {
  activeFaultCode = activeFaultCode === code ? null : code;
  renderFaultsPanel();
  applyFilters();
  renderTimeline();
}

function selectLatencyTag(tag) {
  activeLatencyTag = activeLatencyTag === tag ? null : tag;
  renderLatencyPanel();
  applyFilters();
  renderTimeline();
}

// ── Stats Bar ────────────────────────────────────────────────
function renderStats() {
  const bar = document.getElementById('stats-bar');
  bar.innerHTML = '';
  if (!allEntries.length && !signalData.size) return;

  const levelCounts = {};
  const procCounts  = {};
  for (const e of allEntries) {
    const lv = canonLevel(e.level);
    levelCounts[lv] = (levelCounts[lv] || 0) + 1;
    procCounts[e.process] = (procCounts[e.process] || 0) + 1;
  }

  const frag = document.createDocumentFragment();
  const sep = () => { const s = document.createElement('span'); s.className = 'stat-sep'; s.textContent = '·'; return s; };

  // Per-level chips (severity order), clickable to filter
  const order = ['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'ALWAYS'];
  let first = true;
  order.forEach(lv => {
    if (!levelCounts[lv]) return;
    if (!first) frag.appendChild(sep());
    first = false;
    const chip = document.createElement('span');
    chip.className = 'stat-chip';
    chip.innerHTML =
      `<span class="stat-dot" style="background:${LEVEL_COLORS[lv] || '#94a3b8'}"></span>` +
      `<span class="stat-label">${lv}</span>` +
      `<span class="stat-val">${levelCounts[lv].toLocaleString()}</span>`;
    frag.appendChild(chip);
  });

  // Fault summary (open via the FAULTS pill)
  if (faultStats.length) {
    frag.appendChild(sep());
    const worst = LEVEL_COLORS[faultStats[0].severity] || LEVEL_COLORS.ERROR;  // sorted worst-first
    const chip = document.createElement('span');
    chip.className = 'stat-chip';
    chip.innerHTML =
      `<span class="stat-label" style="color:${worst}">⚠ FAULTS</span>` +
      `<span class="stat-val" style="color:${worst}">${faultStats.length} code${faultStats.length > 1 ? 's' : ''} · ${faultSamples.length.toLocaleString()} lines</span>`;
    frag.appendChild(chip);
  }

  // Latency summary (open via the LATENCY pill)
  if (latencySamples.length) {
    frag.appendChild(sep());
    const lat = document.createElement('span');
    lat.className = 'stat-chip';
    lat.innerHTML =
      `<span class="stat-dot" style="background:var(--cyan)"></span>` +
      `<span class="stat-label">LAT</span>` +
      `<span class="stat-val">${latencySamples.length.toLocaleString()} samples · ${latencyStats.length} tags</span>`;
    frag.appendChild(lat);
  }

  // Clock-skew warning (inspect via LANES: FILE)
  if (clockSkew.length) {
    frag.appendChild(sep());
    const chip = document.createElement('span');
    chip.className = 'stat-chip';
    chip.title = clockSkew.map(s =>
      `${s.file} starts +${fmtDuration(s.offsetMs)} after the earliest file (${fmtClock(s.tMin)}→${fmtClock(s.tMax)})`
    ).join('\n');
    chip.innerHTML =
      `<span class="stat-label" style="color:${LEVEL_COLORS.WARN}">⚠ CLOCK SKEW</span>` +
      `<span class="stat-val" style="color:${LEVEL_COLORS.WARN}">${clockSkew.length} file${clockSkew.length > 1 ? 's' : ''}</span>`;
    frag.appendChild(chip);
  }

  // Numeric signals summary (open via the SIGNALS pill)
  if (signalData.size) {
    frag.appendChild(sep());
    const sig = document.createElement('span');
    sig.className = 'stat-chip';
    sig.title = signalsTruncated ? '⚠ sample cap hit — some samples were dropped' : '';
    sig.innerHTML =
      `<span class="stat-dot" style="background:${SIGNAL_COLORS[0]}"></span>` +
      `<span class="stat-label">SIG</span>` +
      `<span class="stat-val">${signalData.size.toLocaleString()} signal${signalData.size > 1 ? 's' : ''}${signalsTruncated ? ' ⚠' : ''}</span>`;
    frag.appendChild(sig);
  }

  // Time span
  frag.appendChild(sep());
  const span = document.createElement('span');
  span.className = 'stat-chip';
  span.innerHTML =
    `<span class="stat-label">SPAN</span>` +
    `<span class="stat-val">${fmtClock(tStart)}→${fmtClock(tEnd)} (${fmtDuration(tEnd - tStart)})</span>`;
  frag.appendChild(span);

  // Top noisiest processes
  const top = Object.entries(procCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length) {
    frag.appendChild(sep());
    const noisy = document.createElement('span');
    noisy.className = 'stat-chip';
    noisy.innerHTML = `<span class="stat-label">TOP</span>`;
    top.forEach(([p, c]) => {
      const el = document.createElement('span');
      el.className = 'stat-val stat-proc';
      el.style.color = hashColor(p);
      el.textContent = `${p} ${c.toLocaleString()}`;
      noisy.appendChild(el);
      noisy.appendChild(document.createTextNode(' '));
    });
    frag.appendChild(noisy);
  }

  bar.appendChild(frag);
}

// ── Timeline histogram / lanes ───────────────────────────────
function renderTimeline() {
  const canvas = document.getElementById('timeline-canvas');
  const barEl  = document.getElementById('timeline-bar');
  if (!canvas || !barEl || (!allEntries.length && !signalData.size) || tEnd <= tStart) return;

  // Lanes mode grows the bar to fit; reset to the CSS default when off
  const lanes = laneMode !== null && allEntries.length ? computeLanes() : null;
  barEl.style.height = lanes
    ? Math.max(56, Math.min(maxLaneBarHeight(), lanes.length * LANE_H + 8)) + 'px'
    : '';

  const w = barEl.clientWidth, h = barEl.clientHeight;
  if (!w || !h) return;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  if (lanes) {
    renderTimelineLanes(ctx, w, h, lanes);
    drawSignalOverlay(ctx, w, h);
    return;
  }

  const nb = Math.max(1, Math.floor(w));   // ~1px buckets
  const span = tEnd - tStart;
  const buckets = Array.from({ length: nb }, () => ({ info: 0, warn: 0, err: 0 }));

  for (const e of allEntries) {
    let b = Math.floor(((e._t - tStart) / span) * nb);
    if (b < 0) b = 0; else if (b >= nb) b = nb - 1;
    const lv = canonLevel(e.level);
    if (lv === 'ERROR' || lv === 'FATAL')     buckets[b].err++;
    else if (lv === 'WARN')                   buckets[b].warn++;
    else                                      buckets[b].info++;
  }

  let max = 1;
  for (const bk of buckets) max = Math.max(max, bk.info + bk.warn + bk.err);

  const dim = getComputedStyle(document.documentElement)
    .getPropertyValue('--text-dimmer').trim() || '#484f58';

  for (let i = 0; i < nb; i++) {
    const bk = buckets[i];
    if (!(bk.info + bk.warn + bk.err)) continue;
    let y = h;
    const seg = (count, color) => {
      if (!count) return;
      const sh = (count / max) * h;
      ctx.fillStyle = color;
      ctx.fillRect(i, y - sh, 1, sh);
      y -= sh;
    };
    seg(bk.info, dim);
    seg(bk.warn, LEVEL_COLORS.WARN);
    seg(bk.err,  LEVEL_COLORS.ERROR);
  }

  // Fault strip: severity ticks along the top edge — fault dumps are logged
  // at INFO, so the level histogram alone would hide them
  if (faultSamples.length) {
    for (const e of faultSamples) {
      const dimmed = activeFaultCode !== null && e.fault_code !== activeFaultCode;
      ctx.fillStyle = (LEVEL_COLORS[e.fault_severity] || LEVEL_COLORS.ERROR) + (dimmed ? '33' : '');
      const x = Math.min(w - 1, ((e._t - tStart) / span) * w);
      ctx.fillRect(x, 0, 1, 5);
    }
  }

  // Latency scatter overlay (log-scale Y) while the latency panel is open
  if (dockTab === 'latency' && latencySamples.length) {
    let maxLat = 0;
    for (const e of latencySamples) if (e.latency_ms > maxLat) maxLat = e.latency_ms;
    const denom  = Math.log1p(maxLat) || 1;
    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent').trim() || '#f0b429';
    const baseAlpha = activeLatencyTag === null ? 'aa' : '44';
    const drawPass = activePass => {
      ctx.fillStyle = activePass ? accent : accent + baseAlpha;
      for (const e of latencySamples) {
        const isActive = activeLatencyTag !== null && e.latency_tag === activeLatencyTag;
        if (activePass !== isActive) continue;
        const x = Math.min(w - 2, ((e._t - tStart) / span) * w);
        const y = h - 2 - (Math.log1p(e.latency_ms) / denom) * (h - 4);
        ctx.fillRect(x, y, 2, 2);
      }
    };
    drawPass(false);
    if (activeLatencyTag !== null) drawPass(true);
    ctx.fillStyle = accent;
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(`max ${fmtMs(maxLat)}`, 4, 3);
  }

  drawSignalOverlay(ctx, w, h);
}

const MAX_PROC_LANES = 8;  // proc mode: top N by count, rest folded into 'other'
const LANE_H = 16;         // px per lane — lanes are folded rather than squeezed below this

function maxLaneBarHeight() {
  return Math.min(300, Math.round(window.innerHeight * 0.38));
}

function computeLanes() {
  // Fold the least-active sources into 'other' so every lane keeps ≥LANE_H
  const maxLanes = Math.max(3, Math.floor((maxLaneBarHeight() - 8) / LANE_H));

  if (laneMode === 'file') {
    const counts = {};
    for (const e of allEntries) {
      const f = e.file ?? '(unknown)';
      counts[f] = (counts[f] || 0) + 1;
    }
    const names = Object.keys(counts).sort();
    const mk = k => ({ key: k, match: e => (e.file ?? '(unknown)') === k });
    if (names.length <= maxLanes) return names.map(mk);
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])
      .slice(0, maxLanes - 1).map(([f]) => f);
    const topSet = new Set(top);
    const lanes = top.sort().map(mk);
    lanes.push({
      key: `other (${names.length - top.length} files)`,
      match: e => !topSet.has(e.file ?? '(unknown)'),
    });
    return lanes;
  }

  const counts = {};
  for (const e of allEntries) counts[e.process] = (counts[e.process] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])
    .slice(0, Math.min(MAX_PROC_LANES, maxLanes - 1)).map(([p]) => p);
  const topSet = new Set(top);
  const lanes = top.map(p => ({ key: p, match: e => e.process === p }));
  if (Object.keys(counts).length > top.length) {
    lanes.push({ key: 'other', match: e => !topSet.has(e.process) });
  }
  return lanes;
}

// Lane labels: strip the boilerplate every bag file shares
function laneLabel(key) {
  const s = key.replace(/\.(txt|log)$/i, '').replace(/_stdout$/i, '');
  return s.length > 38 ? s.slice(0, 37) + '…' : s;
}

function renderTimelineLanes(ctx, w, h, lanes) {
  const span  = tEnd - tStart;
  const nb    = Math.max(1, Math.floor(w));
  const laneH = h / lanes.length;
  const css      = getComputedStyle(document.documentElement);
  const surface  = css.getPropertyValue('--surface').trim() || '#161b22';
  const labelCol = css.getPropertyValue('--text-dim').trim() || '#8b949e';
  const divider  = css.getPropertyValue('--border-dim').trim() || '#21262d';
  ctx.font = '9px "JetBrains Mono", monospace';
  ctx.textBaseline = 'top';

  lanes.forEach((lane, li) => {
    const y0 = li * laneH;
    const buckets = new Array(nb).fill(0);
    const worst   = new Array(nb).fill(0);  // 0 none, 1 warn, 2 error/fatal
    let tMin = Infinity, tMax = -Infinity, count = 0;

    for (const e of allEntries) {
      if (!lane.match(e)) continue;
      count++;
      if (e._t < tMin) tMin = e._t;
      if (e._t > tMax) tMax = e._t;
      let b = Math.floor(((e._t - tStart) / span) * nb);
      if (b < 0) b = 0; else if (b >= nb) b = nb - 1;
      buckets[b]++;
      const lv = canonLevel(e.level);
      if (lv === 'ERROR' || lv === 'FATAL') worst[b] = 2;
      else if (lv === 'WARN' && worst[b] < 1) worst[b] = 1;
    }
    if (!count) return;

    let max = 1;
    for (const c of buckets) if (c > max) max = c;
    const color = hashColor(lane.key);

    // Faint [tMin, tMax] extent strip — makes clock skew between sources visible
    const xa = ((tMin - tStart) / span) * w;
    const xb = ((tMax - tStart) / span) * w;
    ctx.fillStyle = color + '22';
    ctx.fillRect(xa, y0 + 1, Math.max(1, xb - xa), laneH - 2);

    // Density strip; WARN/ERROR buckets over-plotted in level colors
    for (let i = 0; i < nb; i++) {
      if (!buckets[i]) continue;
      if (worst[i] === 2)      ctx.fillStyle = LEVEL_COLORS.ERROR;
      else if (worst[i] === 1) ctx.fillStyle = LEVEL_COLORS.WARN;
      else {
        const alpha = Math.round(70 + (buckets[i] / max) * 185).toString(16).padStart(2, '0');
        ctx.fillStyle = color + alpha;
      }
      ctx.fillRect(i, y0 + 2, 1, laneH - 4);
    }

    // Lane divider
    ctx.fillStyle = divider;
    ctx.fillRect(0, Math.round(y0 + laneH) - 1, w, 1);

    // Label on a backing chip: color swatch + theme text, readable over strips
    if (laneH >= 12) {
      const label = laneLabel(lane.key);
      const tw = (ctx.measureText(label) || { width: label.length * 6 }).width;
      ctx.fillStyle = surface + 'd9';
      ctx.fillRect(2, y0 + 1, tw + 15, Math.min(13, laneH - 2));
      ctx.fillStyle = color;
      ctx.fillRect(4, y0 + 4, 6, 6);
      ctx.fillStyle = labelCol;
      ctx.fillText(label, 13, y0 + 3);
    }
  });
}

function setLaneMode(mode) {
  laneMode = mode;
  const btn = document.getElementById('lanes-toggle');
  btn.textContent = 'SPLIT: ' + (mode === null ? 'OFF' : mode === 'proc' ? 'PROCESS' : 'FILE');
  btn.classList.toggle('active', mode !== null);
}

function cycleLaneMode() {
  setLaneMode(laneMode === null ? 'proc' : laneMode === 'proc' ? 'file' : null);
  renderTimeline();
}

// ── Clock-skew detection ─────────────────────────────────────
const SKEW_MIN_OFFSET_MS  = 60_000;  // heuristic: file starts >60s after the earliest…
const SKEW_MAX_OVERLAP    = 0.5;     // …and overlaps the others' span by <50%

function detectClockSkew(entries) {
  const files = new Map();  // file → {tMin, tMax}
  for (const e of entries) {
    const f = e.file ?? '(unknown)';
    const cur = files.get(f);
    if (!cur) files.set(f, { tMin: e._t, tMax: e._t });
    else {
      if (e._t < cur.tMin) cur.tMin = e._t;
      if (e._t > cur.tMax) cur.tMax = e._t;
    }
  }
  if (files.size < 2) return [];
  const minStart = Math.min(...[...files.values()].map(v => v.tMin));
  const flagged = [];
  for (const [f, v] of files) {
    const offset = v.tMin - minStart;
    if (offset <= SKEW_MIN_OFFSET_MS) continue;
    let oMin = Infinity, oMax = -Infinity;
    for (const [g, u] of files) {
      if (g === f) continue;
      if (u.tMin < oMin) oMin = u.tMin;
      if (u.tMax > oMax) oMax = u.tMax;
    }
    const fileSpan = Math.max(1, v.tMax - v.tMin);
    const overlap  = Math.max(0, Math.min(v.tMax, oMax) - Math.max(v.tMin, oMin));
    if (overlap / fileSpan < SKEW_MAX_OVERLAP) {
      flagged.push({ file: f, offsetMs: offset, tMin: v.tMin, tMax: v.tMax });
    }
  }
  return flagged;
}

function jumpToTime(t) {
  if (!displayRows.length) return;
  let idx = displayRows.findIndex(r => r.entry._t >= t);
  if (idx < 0) idx = displayRows.length - 1;
  document.getElementById('log-container').scrollTop = idx * ROW_H;
}

// ── Scrollbar error markers ──────────────────────────────────
function renderScrollMarkers() {
  const rail = document.getElementById('scroll-markers');
  if (!rail) return;
  rail.innerHTML = '';
  const total = displayRows.length;
  if (!total) return;

  const frag = document.createDocumentFragment();
  const seen = new Set();
  for (let i = 0; i < total; i++) {
    const entry = displayRows[i].entry;
    const lv = canonLevel(entry.level);
    const fsev = entry.fault_severity;
    let color = null;
    if (lv === 'ERROR' || lv === 'FATAL' || fsev === 'ERROR' || fsev === 'FATAL') color = LEVEL_COLORS.ERROR;
    else if (lv === 'WARN' || fsev === 'WARN')                                    color = LEVEL_COLORS.WARN;
    if (!color) continue;
    const pct = Math.round((i / total) * 1000) / 10;  // 0.1% buckets cap DOM size
    const key = color + pct;
    if (seen.has(key)) continue;
    seen.add(key);
    const tick = document.createElement('div');
    tick.className = 'scroll-marker';
    tick.style.top = pct + '%';
    tick.style.background = color;
    frag.appendChild(tick);
  }
  rail.appendChild(frag);
}

// ── Time-range readout ───────────────────────────────────────
function showRangeReadout() {
  const box = document.getElementById('timeline-range');
  const txt = document.getElementById('range-text');
  if (rangeStart === null) { box.classList.add('hidden'); return; }
  txt.textContent = `${fmtClock(rangeStart)} → ${fmtClock(rangeEnd)}`;
  box.classList.remove('hidden');
}

function clearRange() {
  rangeStart = rangeEnd = null;
  document.querySelector('.timeline-selection')?.remove();
  showRangeReadout();
  applyFilters();
}

// Rebuild the .timeline-selection div from rangeStart/rangeEnd — used when
// a range is restored from a deep link rather than drawn by the mouse.
function drawRangeSelection() {
  document.querySelector('.timeline-selection')?.remove();
  if (rangeStart === null || tEnd <= tStart) return;
  const bar = document.getElementById('timeline-bar');
  const w = bar.clientWidth;
  if (!w) return;
  const span = tEnd - tStart;
  const a = ((rangeStart - tStart) / span) * w;
  const b = ((rangeEnd   - tStart) / span) * w;
  const el = document.createElement('div');
  el.className = 'timeline-selection';
  el.style.left  = Math.min(a, b) + 'px';
  el.style.width = Math.abs(b - a) + 'px';
  bar.appendChild(el);
}

// ── Inspector panel ──────────────────────────────────────────
function fallbackCopy(text, onSuccess) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy'); onSuccess?.(); } catch {}
  document.body.removeChild(ta);
}

function openInspector(entry) {
  const body = document.getElementById('inspector-body');
  const metaFields = [
    ['Timestamp', entry.timestamp],
    ['Process',   entry.process],
    ['Level',     entry.level],
    ['Module',    entry.module],
    ['Source',    entry.source || '—'],
    ['Line #',    entry.line_number],
  ];
  if (entry.count    != null) metaFields.push(['Count',   entry.count]);
  if (entry.age      != null) metaFields.push(['Age',     entry.age]);
  if (entry.latency_ms != null) {
    metaFields.push(['Latency', `${fmtMs(entry.latency_ms)} — ${entry.latency_tag} (${entry.latency_pattern})`]);
  }
  if (entry.fault_code) {
    metaFields.push(['Fault', `${entry.fault_code} (${entry.fault_severity}${entry.fault_count != null ? `, reported ${entry.fault_count}×` : ''})`]);
  }

  let html = metaFields.map(([k, v]) =>
    `<div class="insp-field"><div class="insp-key">${esc(k)}</div>` +
    `<div class="insp-val">${esc(String(v))}</div></div>`
  ).join('');
  const msgLabel = entry.fault_message != null ? 'Fault Message' : 'Message';
  const msgVal   = entry.fault_message ?? entry.message;
  html += `<div class="insp-field insp-field--message"><div class="insp-key">${msgLabel}</div>` +
    `<div class="insp-val">${esc(msgVal)}</div></div>`;
  html += `<button class="insp-copy" id="insp-copy">COPY RAW</button>`;
  body.innerHTML = html;

  // color the process value to match the row
  const procVal = body.querySelectorAll('.insp-val')[1];
  if (procVal) procVal.style.color = hashColor(entry.process);

  document.getElementById('insp-copy').addEventListener('click', () => {
    const fields = [...body.querySelectorAll('.insp-field')];
    const text = fields.map(f => {
      const k = f.querySelector('.insp-key')?.textContent ?? '';
      const v = f.querySelector('.insp-val')?.textContent ?? '';
      return `${k}: ${v}`;
    }).join('\n');

    const btn = document.getElementById('insp-copy');
    const confirm = () => {
      btn.textContent = 'COPIED ✓';
      setTimeout(() => { btn.textContent = 'COPY RAW'; }, 1200);
    };

    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(confirm).catch(() => fallbackCopy(text, confirm));
    } else {
      fallbackCopy(text, confirm);
    }
  });

  selectedEntry = entry;
  serializeHash();
  openDock('inspect');
}

function closeInspector() {
  if (selectedEntry !== null) {
    selectedEntry = null;
    serializeHash();
  }
  document.getElementById('inspector-body').innerHTML =
    '<div class="insp-empty">Select a log row to see its details.</div>';
  if (dockTab === 'inspect') closeDock();
}

// ── Analysis dock (INSPECT / LATENCY / SIGNALS tabs) ─────────
function renderDock() {
  document.getElementById('dock').classList.toggle('hidden', dockTab === null);
  document.querySelectorAll('.dock-tab').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tab === dockTab));
  document.getElementById('dock-faults').classList.toggle('active', dockTab === 'faults');
  document.getElementById('dock-inspect').classList.toggle('active', dockTab === 'inspect');
  document.getElementById('dock-latency').classList.toggle('active', dockTab === 'latency');
  document.getElementById('dock-signals').classList.toggle('active', dockTab === 'signals');
  for (const [id, tab] of [['faults-toggle', 'faults'], ['latency-toggle', 'latency'], ['signals-toggle', 'signals']]) {
    const btn = document.getElementById(id);
    btn.classList.toggle('active', dockTab === tab);
    btn.setAttribute('aria-pressed', String(dockTab === tab));
  }
  if (dockTab === 'faults')  renderFaultsPanel();
  if (dockTab === 'latency') renderLatencyPanel();
  if (dockTab === 'signals') renderSignalsPanel();
}

function openDock(tab) {
  if (dockTab === tab) return;
  const latencyVisibilityChanged = (dockTab === 'latency') !== (tab === 'latency');
  dockTab = tab;
  renderDock();
  if (latencyVisibilityChanged) renderTimeline();  // scatter overlay follows the latency tab
}

function closeDock() {
  if (dockTab === null) return;
  const wasLatency = dockTab === 'latency';
  dockTab = null;
  renderDock();
  let refilter = false;  // dock gone = its filters gone; no hidden state
  if (activeLatencyTag !== null) { activeLatencyTag = null; refilter = true; }
  if (activeFaultCode !== null)  { activeFaultCode = null;  refilter = true; }
  if (refilter) applyFilters();
  if (wasLatency || refilter) renderTimeline();
}

function toggleDockTab(tab) {
  dockTab === tab ? closeDock() : openDock(tab);
}

// ── Analyze (metrics + triage via /api/process) ──────────────
// Sends the current (filtered) entries to the backend, which runs the same
// analyzer the CLI `process` subcommand uses, and renders summary + triage.
async function openAnalyze() {
  if (!allEntries.length) return;
  const modal = document.getElementById('analyze-modal');
  const body  = document.getElementById('analyze-body');
  modal.classList.remove('hidden');

  const filtered = filteredEntries.length < allEntries.length;
  const scope = filtered
    ? `${filteredEntries.length.toLocaleString()} filtered`
    : `${allEntries.length.toLocaleString()}`;
  body.innerHTML = `<div class="az-status">analyzing ${scope} entries&hellip;</div>`;

  let res;
  try {
    res = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: filteredEntries, top: 20 }),
    });
  } catch (err) {
    body.innerHTML = `<div class="az-status az-error">analysis failed: ${esc(String(err))}</div>`;
    return;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    body.innerHTML = `<div class="az-status az-error">${esc(data.reason || ('HTTP ' + res.status))}</div>`;
    return;
  }
  const data = await res.json();
  renderAnalyze(data.summary, data.triage, filtered);
}

function closeAnalyze() {
  document.getElementById('analyze-modal').classList.add('hidden');
}

function azMetric(label, val, color) {
  return `<div class="az-metric"><div class="az-metric-val"${color ? ` style="color:${color}"` : ''}>` +
    `${esc(String(val))}</div><div class="az-metric-label">${esc(label)}</div></div>`;
}

// rows: [[cellHtml, count], ...] — cellHtml is trusted markup (already escaped within).
function azTable(title, colLabel, rows) {
  let h = `<section class="az-section"><h3 class="az-h">${esc(title)}</h3><table class="az-table">`;
  h += `<thead><tr><th>${esc(colLabel)}</th><th class="az-num">count</th></tr></thead><tbody>`;
  for (const [cell, count] of rows) {
    h += `<tr><td>${cell}</td><td class="az-num">${esc(String(count))}</td></tr>`;
  }
  return h + `</tbody></table></section>`;
}

function renderAnalyze(summary, triage, filtered) {
  const body = document.getElementById('analyze-body');
  const span = summary.duration_s != null ? `${summary.duration_s.toFixed(1)}s` : 'n/a';

  let html = '';
  if (filtered) html += `<div class="az-scope">analysis reflects the current filtered view</div>`;

  html += `<section class="az-section"><div class="az-metrics">`;
  html += azMetric('ENTRIES', summary.total.toLocaleString());
  html += azMetric('ERRORS', summary.error_count.toLocaleString(), LEVEL_COLORS.ERROR);
  html += azMetric('WARNINGS', summary.warn_count.toLocaleString(), LEVEL_COLORS.WARN);
  html += azMetric('SPAN', span);
  html += `</div></section>`;

  html += azTable('BY LEVEL', 'level',
    Object.entries(summary.by_level).sort((a, b) => b[1] - a[1]).map(([lv, n]) =>
      [`<span style="color:${LEVEL_COLORS[lv] || 'var(--text-dim)'}">${esc(lv)}</span>`, n]));

  html += azTable('TOP PROCESSES', 'process',
    Object.entries(summary.by_process).slice(0, 10).map(([p, n]) =>
      [`<span style="color:${hashColor(p)}">${esc(p)}</span>`, n]));

  html += `<section class="az-section"><h3 class="az-h">TRIAGE &mdash; ${triage.finding_count} findings ` +
    `(<span style="color:${LEVEL_COLORS.FATAL}">${triage.fatal} fatal</span>, ` +
    `<span style="color:${LEVEL_COLORS.ERROR}">${triage.error} error</span>, ` +
    `<span style="color:${LEVEL_COLORS.WARN}">${triage.warn} warn</span>)</h3>`;
  if (!triage.findings.length) {
    html += `<div class="az-empty">No ERROR/FATAL/WARN findings.</div>`;
  } else {
    html += `<div class="az-findings">`;
    for (const f of triage.findings) {
      const c = LEVEL_COLORS[f.severity] || 'var(--text-dim)';
      html += `<div class="az-finding">` +
        `<div class="az-finding-head">` +
        `<span class="az-sev" style="color:${c};border-color:${c}">${esc(f.severity)}</span>` +
        `<span class="az-fcount">&times;${f.count.toLocaleString()}</span>` +
        `<span class="az-fprocs">${esc(f.processes.join(', '))}</span></div>` +
        `<div class="az-fmsg">${esc(f.sample_message)}</div>` +
        `<div class="az-fmeta">${esc(f.first_ts || '?')} &rarr; ${esc(f.last_ts || '?')}</div>` +
        `</div>`;
    }
    html += `</div>`;
  }
  html += `</section>`;

  body.innerHTML = html;
}

// ── Level Pills ──────────────────────────────────────────────
function syncLevelPills() {
  document.querySelectorAll('#level-pills .pill').forEach(pill => {
    const lv = pill.dataset.level;
    pill.classList.toggle('active',
      lv === 'ALL' ? activeLevels === null : activeLevels !== null && activeLevels.has(lv)
    );
  });
}

// ── Process Dropdown ─────────────────────────────────────────
function buildProcessDropdown(preselected = null) {
  const processes = [...new Set(allEntries.map(e => e.process))].sort();
  const menu      = document.getElementById('dropdown-menu');
  menu.innerHTML  = '';

  const mkItem = (value, labelHtml, checked = true) => {
    const lbl = document.createElement('label');
    lbl.className = 'dropdown-item';
    lbl.innerHTML =
      `<input type="checkbox" value="${esc(value)}"${checked ? ' checked' : ''}> ${labelHtml}`;
    return lbl;
  };

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search…';
  searchInput.className = 'dropdown-search';
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase();
    menu.querySelectorAll('.dropdown-item').forEach(item => {
      const isAll = item.querySelector('input').value === '__ALL__';
      item.style.display = (!q || isAll || item.textContent.toLowerCase().includes(q)) ? '' : 'none';
    });
  });
  menu.appendChild(searchInput);

  menu.appendChild(mkItem('__ALL__', 'All processes', preselected === null));
  processes.forEach(p => {
    const color = hashColor(p);
    const item = mkItem(p, `<span style="color:${color}">${esc(p)}</span>`,
                        preselected === null || preselected.has(p));
    item.addEventListener('dblclick', () => {
      activeProcesses = new Set([p]);
      menu.querySelectorAll('input').forEach(c => { c.checked = c.value === p; });
      syncDropdownLabel();
      applyFilters();
    });
    menu.appendChild(item);
  });

  menu.addEventListener('change', e => {
    const allChk   = menu.querySelector('input[value="__ALL__"]');
    const procChks = [...menu.querySelectorAll('input:not([value="__ALL__"])')];

    if (e.target.value === '__ALL__') {
      // "All processes" toggled — sync every process checkbox to match
      const checked = allChk.checked;
      procChks.forEach(c => { c.checked = checked; });
      activeProcesses = checked ? null : new Set();
    } else {
      // A specific process was toggled
      const allSelected = procChks.every(c => c.checked);
      if (allSelected) {
        allChk.checked = true;
        activeProcesses = null;
      } else {
        allChk.checked = false;
        activeProcesses = new Set(procChks.filter(c => c.checked).map(c => c.value));
      }
    }

    syncDropdownLabel();
    applyFilters();
  });

  activeProcesses = preselected;
  syncDropdownLabel();
}

function syncDropdownLabel() {
  const n = activeProcesses === null ? null : activeProcesses.size;
  document.getElementById('dropdown-label').textContent =
    n === null ? 'All processes' : n === 0 ? 'No processes' : `${n} selected`;
}

// ── Upload ───────────────────────────────────────────────────
async function handleUpload(files) {
  if (!files || !files.length) return;
  uploadedFiles = Array.from(files);

  showLoading(true);
  hideError();

  const worker = new Worker('/parser.worker.js');
  try {
    const allEntries = [];
    const signalChunks = [];
    let truncated = false;
    for (const file of uploadedFiles) {
      const data = await new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => {
          // big logs arrive as N 'chunk' messages followed by one 'done'
          if (data.type === 'chunk') {
            for (const e of data.entries) { e.file = file.name; allEntries.push(e); }
            return;
          }
          if (data.type === 'done')  resolve(data);
          if (data.type === 'error') reject(new Error(data.message));
        };
        worker.onerror = e => reject(new Error(e.message));
        worker.postMessage({ file });
      });
      for (const e of data.entries) { e.file = file.name; allEntries.push(e); }
      if (data.signals) signalChunks.push(...data.signals);
      if (data.truncated) truncated = true;
    }
    allEntries.sort((a, b) => a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0);
    showLoading(false);
    loadViewer(allEntries, signalChunks, truncated);
  } catch (err) {
    showLoading(false);
    showError(String(err.message));
  } finally {
    worker.terminate();
  }
}

function loadViewer(entries, signals = [], truncated = false) {
  // Precompute numeric epoch-ms per entry + dataset bounds (Feature 0)
  for (const e of entries) {
    e._t = Date.parse(e.timestamp.slice(0, 23).replace(' ', 'T'));
  }

  // Numeric signals: merge chunks across files, sort by time, compute stats
  signalData = new Map();
  for (const s of signals) {
    let g = signalData.get(s.signal);
    if (!g) signalData.set(s.signal, g = { t: [], v: [] });
    for (let i = 0; i < s.t.length; i++) { g.t.push(s.t[i]); g.v.push(s.v[i]); }
  }
  signalStats = [];
  for (const [name, g] of signalData) {
    let sorted = true;
    for (let i = 1; i < g.t.length; i++) if (g.t[i] < g.t[i - 1]) { sorted = false; break; }
    if (!sorted) {
      const idx = g.t.map((_, i) => i).sort((a, b) => g.t[a] - g.t[b]);
      g.t = idx.map(i => g.t[i]);
      g.v = idx.map(i => g.v[i]);
    }
    let min = Infinity, max = -Infinity, sum = 0;
    for (const v of g.v) { if (v < min) min = v; if (v > max) max = v; sum += v; }
    g.min = min; g.max = max;
    signalStats.push({ name, count: g.v.length, min, mean: sum / g.v.length, max });
  }
  activeSignals    = [];
  signalsTruncated = truncated;
  signalsFilter    = '';
  document.getElementById('signals-search').value = '';
  document.getElementById('signals-toggle').classList.toggle('hidden', !signalData.size);
  document.getElementById('dock-tab-signals').classList.toggle('hidden', !signalData.size);

  // dataset bounds — from entries; a signals-only drop falls back to signal range
  tStart = Infinity;
  tEnd   = -Infinity;
  for (const e of entries) {
    if (e._t < tStart) tStart = e._t;
    if (e._t > tEnd)   tEnd   = e._t;
  }
  if (!entries.length) {
    for (const [, g] of signalData) {
      if (!g.t.length) continue;
      if (g.t[0] < tStart)              tStart = g.t[0];
      if (g.t[g.t.length - 1] > tEnd)   tEnd   = g.t[g.t.length - 1];
    }
  }
  if (!isFinite(tStart)) { tStart = 0; tEnd = 0; }

  allEntries      = entries;
  filteredEntries = entries;
  activeLevels    = null;
  activeProcesses = null;
  searchRegex     = null;
  excludeRegex    = null;
  rangeStart      = rangeEnd = null;
  collapseRepeats = false;
  expandedGroups.clear();

  setLaneMode(null);
  clockSkew = detectClockSkew(entries);

  // Latency stats for the dataset
  latencyStats     = computeLatencyStats(entries);
  latencySamples   = entries.filter(e => e.latency_ms != null);
  latencySortKey   = 'p95';
  latencySortDir   = -1;
  activeLatencyTag = null;
  document.getElementById('latency-toggle').classList.toggle('hidden', !latencySamples.length);
  document.getElementById('dock-tab-latency').classList.toggle('hidden', !latencySamples.length);

  // Fault ledger for the dataset
  faultStats      = computeFaultStats(entries);
  faultSamples    = entries.filter(e => e.fault_code);
  activeFaultCode = null;
  faultsSortKey   = 'severity';
  faultsSortDir   = -1;
  document.getElementById('faults-toggle').classList.toggle('hidden', !faultStats.length);
  document.getElementById('dock-tab-faults').classList.toggle('hidden', !faultStats.length);

  // Reset UI
  document.getElementById('search-input').value = '';
  document.getElementById('exclude-input').value = '';
  document.getElementById('collapse-toggle').classList.remove('active');
  document.getElementById('collapse-toggle').setAttribute('aria-pressed', 'false');
  document.querySelector('.timeline-selection')?.remove();
  showRangeReadout();
  dockTab = null;
  renderDock();
  closeInspector();
  closeAnalyze();
  syncLevelPills();
  buildProcessDropdown();
  buildDisplayRows();
  updateResultCount();
  renderStats();
  renderScrollMarkers();

  document.getElementById('header-files').textContent =
    uploadedFiles.map(f => f.name).join('  ·  ');
  document.getElementById('entry-count').textContent =
    `${entries.length.toLocaleString()} entries`;

  // Faults first: auto-open the ledger when the bag contains faults
  if (faultStats.length) openDock('faults');

  // Restore deep-link state (consumed once, on the first load after page open)
  if (pendingHashState) {
    applyHashState(pendingHashState);
    pendingHashState = null;
  }

  showViewer();
}

// ── OCI / run-id source (CoreStack acquisition layer) ────────
// Sibling of handleUpload: parse preloaded {name,text} items via the worker and
// load them into the same viewer. Used by the OCI run-id picker below.
async function loadSources(items) {
  if (!items || !items.length) return;
  uploadedFiles = items.map(it => ({ name: it.name }));

  showLoading(true);
  hideError();

  const worker = new Worker('/parser.worker.js');
  try {
    const collected = [];
    const signalChunks = [];
    let truncated = false;
    for (const it of items) {
      const data = await new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => {
          // big logs arrive as N 'chunk' messages followed by one 'done'
          if (data.type === 'chunk') {
            for (const e of data.entries) { e.file = it.name; collected.push(e); }
            return;
          }
          if (data.type === 'done')  resolve(data);
          if (data.type === 'error') reject(new Error(data.message));
        };
        worker.onerror = e => reject(new Error(e.message));
        worker.postMessage({ name: it.name, text: it.text });
      });
      for (const e of data.entries) { e.file = it.name; collected.push(e); }
      if (data.signals) signalChunks.push(...data.signals);
      if (data.truncated) truncated = true;
    }
    collected.sort((a, b) => a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0);
    showLoading(false);
    loadViewer(collected, signalChunks, truncated);
  } catch (err) {
    showLoading(false);
    showError(String(err.message));
  } finally {
    worker.terminate();
  }
}

// Wire up the URSA command-line search. When creds are available it resolves a
// run and auto-loads ALL of its logs/ files straight into the parser. When they
// are not (no creds, or a static host with no backend), the input is disabled and
// the drop zone is promoted so local drag-drop still works.
async function initSource() {
  const form       = document.getElementById('source-picker');
  const runidInput = document.getElementById('runid-input');
  const titleEl    = document.getElementById('sp-title');
  const content    = document.querySelector('.upload-content');
  if (!form || !runidInput) return;

  let status = null;
  try {
    status = await fetch('/api/status').then(r => r.json());
  } catch { /* no backend (static host) */ }

  if (!status || status.acquisition !== 'available') {
    // URSA unavailable: dim the command line, promote local drag-drop.
    content?.classList.add('no-oci');
    runidInput.disabled = true;
    runidInput.placeholder = status && status.reason
      ? `URSA unavailable — ${status.reason}`
      : 'URSA unavailable — drop local files below';
    return;
  }

  const setStatus = (msg, busy = false) => {
    titleEl.textContent = msg || '';
    titleEl.classList.toggle('busy', Boolean(busy));
  };

  // Resolve a run, then fetch every file under logs/ and hand them to the parser.
  async function loadRun(runId) {
    runId = (runId || '').trim();
    if (!runId) return;
    hideError();
    setStatus(`resolving ${runId}…`, true);

    let res;
    try {
      res = await fetch('/api/oci/logs?run_id=' + encodeURIComponent(runId));
    } catch (err) {
      setStatus('');
      showError(String(err));
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setStatus('');
      showError(body.reason || `failed to resolve (HTTP ${res.status})`);
      return;
    }

    const data  = await res.json();
    const files = data.files || [];
    const label = data.custom_id || runId;
    if (!files.length) {
      setStatus(`no files under logs/ for ${label}`);
      return;
    }

    // Auto-load all files (no per-file picker).
    try {
      const items = [];
      for (const f of files) {
        setStatus(`${label} · fetching ${items.length + 1}/${files.length}…`, true);
        const r = await fetch('/api/oci/file?run_id=' + encodeURIComponent(runId) +
                              '&key=' + encodeURIComponent(f.key));
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.reason || `failed to fetch ${f.name}`);
        }
        items.push({ name: f.name, text: await r.text() });
      }
      setStatus('');
      loadSources(items);  // shows its own parsing overlay, then the viewer
    } catch (err) {
      setStatus('');
      showError(String(err.message || err));
    }
  }

  form.addEventListener('submit', e => { e.preventDefault(); loadRun(runidInput.value); });

  // If the CLI was launched with a run-id, auto-load it.
  try {
    const src = await fetch('/api/source').then(r => r.json());
    if (src && src.type === 'oci' && src.arg) {
      runidInput.value = src.arg;
      loadRun(src.arg);
    }
  } catch { /* ignore */ }

  runidInput.focus();
}

// ── Screen transitions ───────────────────────────────────────
function showViewer() {
  document.getElementById('upload-screen').classList.remove('active');
  document.getElementById('viewer-screen').classList.add('active');
  requestAnimationFrame(() => { renderRows(); renderTimeline(); drawRangeSelection(); });
}

function showUpload() {
  document.getElementById('viewer-screen').classList.remove('active');
  document.getElementById('upload-screen').classList.add('active');
  allEntries = filteredEntries = [];
  uploadedFiles = [];
  signalData = new Map();
  signalStats = [];
  activeSignals = [];

  // Reset the URSA command line so a fresh run is a clean slate.
  const runidInput = document.getElementById('runid-input');
  const titleEl = document.getElementById('sp-title');
  if (titleEl) { titleEl.textContent = ''; titleEl.classList.remove('busy'); }
  hideError();
  if (runidInput && !runidInput.disabled) {
    runidInput.value = '';
    runidInput.focus();
  }
}

function showLoading(on) {
  document.getElementById('loading-overlay').classList.toggle('hidden', !on);
}

function showError(msg) {
  document.getElementById('error-text').textContent = msg;
  document.getElementById('error-banner').classList.remove('hidden');
}

function hideError() {
  document.getElementById('error-banner').classList.add('hidden');
}

// ── Folder / file drop resolution (FileSystem API) ───────────
function fsEntryToFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function isLogFile(name) {
  return /\.(txt|log)$/i.test(name);
}

function isSignalFile(name) {
  return /\.(csv|jsonl|out)$/i.test(name);
}

function isSupportedFile(name) {
  return isLogFile(name) || isSignalFile(name);
}

const MAX_DIR_DEPTH = 5;  // recursion guard — a bag root is logs/ one level down

async function collectTxtFiles(entry, depth = 0) {
  if (entry.isFile) {
    if (isSupportedFile(entry.name)) return [await fsEntryToFile(entry)];
    return [];
  }
  if (entry.isDirectory && depth < MAX_DIR_DEPTH && !entry.name.startsWith('.')) {
    const reader = entry.createReader();
    const files = [];
    // readEntries returns ≤100 results per call — loop until empty
    while (true) {
      const batch = await readDirEntries(reader);
      if (!batch.length) break;
      for (const child of batch) {
        files.push(...await collectTxtFiles(child, depth + 1));
      }
    }
    return files;
  }
  return [];
}

async function resolveDroppedItems(dataTransfer) {
  // Prefer FileSystem API (supports folders); fall back to .files
  if (dataTransfer.items && dataTransfer.items.length) {
    const files = [];
    for (const item of dataTransfer.items) {
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) {
        files.push(...await collectTxtFiles(entry));
      } else if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    return files;
  }
  return [...dataTransfer.files];
}

// ── Upload-screen matrix rain canvas ─────────────────────────
function initGridCanvas() {
  const canvas = document.getElementById('grid-canvas');
  if (!canvas) return;
  const ctx   = canvas.getContext('2d');
  const FS    = 14;
  const CHARS = 'ABCDEF0123456789[]{}|/\\:.-_=+><@#! ';
  let drops   = [];
  let animId  = null;

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    const n = Math.floor(canvas.width / FS);
    while (drops.length < n) drops.push(-Math.floor(Math.random() * (canvas.height / FS)));
    drops.length = n;
  }

  function draw() {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    // Semi-transparent fill creates the fading trail effect
    ctx.fillStyle = light ? 'rgba(246,248,250,0.08)' : 'rgba(13,17,23,0.08)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.font = `${FS - 1}px 'JetBrains Mono', monospace`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = light ? 'rgba(155,95,5,0.9)' : 'rgba(255,215,90,0.9)';

    for (let i = 0; i < drops.length; i++) {
      if (drops[i] < 0) { drops[i] += 0.25; continue; }
      ctx.fillText(CHARS[Math.random() * CHARS.length | 0], i * FS, drops[i] * FS);
      drops[i] += 0.25 + Math.random() * 0.15;
      if (drops[i] * FS > canvas.height + FS * 4 && Math.random() > 0.975) {
        drops[i] = -Math.floor(Math.random() * 22);
      }
    }

    if (document.getElementById('upload-screen').classList.contains('active')) {
      animId = requestAnimationFrame(draw);
    } else {
      animId = null;
    }
  }

  window.addEventListener('resize', () => {
    resize();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  });
  resize();

  const screen = document.getElementById('upload-screen');
  const observer = new MutationObserver(() => {
    if (screen.classList.contains('active')) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!animId) animId = requestAnimationFrame(draw);
    }
  });
  observer.observe(screen, { attributes: true, attributeFilter: ['class'] });
  animId = requestAnimationFrame(draw);
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initGridCanvas();
  initSource();
  document.getElementById('version-tag').textContent = VERSION;
  pendingHashState = parseHash();

  const dropZone    = document.getElementById('drop-zone');
  const fileInput   = document.getElementById('file-input');
  const logContainer= document.getElementById('log-container');
  const ddTrigger   = document.getElementById('dropdown-trigger');
  const ddMenu      = document.getElementById('dropdown-menu');

  // ── Drag & drop ──
  dropZone.addEventListener('click', e => {
    if (e.target !== fileInput) fileInput.click();
  });
  dropZone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') fileInput.click();
  });
  ['dragenter','dragover'].forEach(ev =>
    dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.add('dragging'); })
  );
  ['dragleave','dragend'].forEach(ev =>
    dropZone.addEventListener(ev, () => dropZone.classList.remove('dragging'))
  );
  dropZone.addEventListener('drop', async e => {
    e.preventDefault();
    dropZone.classList.remove('dragging');
    const files = await resolveDroppedItems(e.dataTransfer);
    if (files.length) handleUpload(files);
  });
  fileInput.addEventListener('change', () => handleUpload(fileInput.files));

  // ── Theme toggles ──
  document.getElementById('upload-theme-btn').addEventListener('click', toggleTheme);
  document.getElementById('viewer-theme-btn').addEventListener('click', toggleTheme);

  // ── Error / clear ──
  document.getElementById('retry-btn').addEventListener('click', () => {
    hideError();
    fileInput.value = '';
    fileInput.click();
  });
  document.getElementById('clear-btn').addEventListener('click', showUpload);

  // ── Analyze (metrics + triage) ──
  document.getElementById('analyze-btn').addEventListener('click', openAnalyze);
  document.getElementById('analyze-close').addEventListener('click', closeAnalyze);
  const analyzeModal = document.getElementById('analyze-modal');
  analyzeModal.addEventListener('click', e => { if (e.target === analyzeModal) closeAnalyze(); });

  // ── Level pills ──
  document.querySelectorAll('#level-pills .pill').forEach(pill => {
    pill.addEventListener('click', () => toggleLevel(pill.dataset.level));
  });

  // ── Process dropdown (fixed positioning to escape any overflow clipping) ──
  function openDropdown() {
    const rect = ddTrigger.getBoundingClientRect();
    ddMenu.style.top  = `${rect.bottom + 4}px`;
    ddMenu.style.left = `${rect.left}px`;
    ddMenu.classList.remove('hidden');
    ddTrigger.classList.add('open');
    ddTrigger.setAttribute('aria-expanded', 'true');
  }
  function closeDropdown() {
    ddMenu.classList.add('hidden');
    ddTrigger.classList.remove('open');
    ddTrigger.setAttribute('aria-expanded', 'false');
  }

  ddTrigger.addEventListener('click', e => {
    e.stopPropagation();
    ddMenu.classList.contains('hidden') ? openDropdown() : closeDropdown();
  });
  document.addEventListener('click', closeDropdown);
  ddMenu.addEventListener('click', e => e.stopPropagation());

  // ── Search + exclude (debounced 150 ms) ──
  let searchTimer;
  document.getElementById('search-input').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchRegex = compileRegex(e.target.value, e.target.closest('.search-wrap'));
      applyFilters();
    }, 150);
  });
  let excludeTimer;
  document.getElementById('exclude-input').addEventListener('input', e => {
    clearTimeout(excludeTimer);
    excludeTimer = setTimeout(() => {
      excludeRegex = compileRegex(e.target.value, e.target.closest('.search-wrap'));
      applyFilters();
    }, 150);
  });

  // ── Collapse repeats toggle ──
  const collapseBtn = document.getElementById('collapse-toggle');
  collapseBtn.addEventListener('click', () => {
    collapseRepeats = !collapseRepeats;
    collapseBtn.classList.toggle('active', collapseRepeats);
    collapseBtn.setAttribute('aria-pressed', String(collapseRepeats));
    expandedGroups.clear();
    buildDisplayRows();
    renderScrollMarkers();
    logContainer.scrollTop = 0;
    renderRows();
    serializeHash();
  });

  // ── Timeline lanes toggle ──
  document.getElementById('lanes-toggle').addEventListener('click', cycleLaneMode);

  // ── Signals panel: toggle pill, search, sortable headers, row click to overlay ──
  document.getElementById('signals-toggle').addEventListener('click', () => toggleDockTab('signals'));
  document.getElementById('signals-search').addEventListener('input', e => {
    signalsFilter = e.target.value;
    renderSignalsPanel();
  });
  document.getElementById('dock-signals').addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      if (signalsSortKey === key) signalsSortDir = -signalsSortDir;
      else { signalsSortKey = key; signalsSortDir = key === 'name' ? 1 : -1; }
      renderSignalsPanel();
      return;
    }
    const tr = e.target.closest('tr[data-sig]');
    if (tr) toggleSignalOverlay(tr.dataset.sig);
  });

  // ── Faults panel: toggle pill, sortable headers, row click to filter ──
  document.getElementById('faults-toggle').addEventListener('click', () => toggleDockTab('faults'));
  document.getElementById('dock-faults').addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      if (faultsSortKey === key) faultsSortDir = -faultsSortDir;
      else { faultsSortKey = key; faultsSortDir = (key === 'code' || key === 'detail') ? 1 : -1; }
      renderFaultsPanel();
      return;
    }
    const tr = e.target.closest('tr[data-flt]');
    if (tr) selectFaultCode(tr.dataset.flt);
  });

  // ── Latency panel: toggle pill, sortable headers, row click to filter ──
  document.getElementById('latency-toggle').addEventListener('click', () => toggleDockTab('latency'));
  document.getElementById('dock-latency').addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      if (latencySortKey === key) latencySortDir = -latencySortDir;
      else { latencySortKey = key; latencySortDir = key === 'tag' ? 1 : -1; }
      renderLatencyPanel();
      return;
    }
    const tr = e.target.closest('tr[data-tag]');
    if (tr) selectLatencyTag(tr.dataset.tag);
  });

  // ── Log rows: click to inspect, or expand a collapsed group ──
  const logRows = document.getElementById('log-rows');
  logRows.addEventListener('click', e => {
    const badge = e.target.closest('.dup-badge');
    if (badge) {
      expandedGroups.add(badge.dataset.group);
      buildDisplayRows();
      renderScrollMarkers();
      renderRows();
      return;
    }
    const rowEl = e.target.closest('.log-row');
    if (!rowEl) return;
    const row = displayRows[+rowEl.dataset.i];
    if (row) openInspector(row.entry);
  });

  // ── Dock: tab switching, close, horizontal resize ──
  document.querySelector('.dock-tabs').addEventListener('click', e => {
    const tab = e.target.closest('.dock-tab');
    if (tab) openDock(tab.dataset.tab);
  });
  document.getElementById('dock-close').addEventListener('click', closeDock);

  const dockEl = document.getElementById('dock');
  const dockHandle = document.getElementById('dock-resize-handle');
  const DOCK_H_KEY = 'log-reader-dock-h';

  const savedDockH = localStorage.getItem(DOCK_H_KEY);
  if (savedDockH) dockEl.style.height = savedDockH + 'px';

  dockHandle.addEventListener('mousedown', e => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = dockEl.offsetHeight;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';

    const onMove = ev => {
      const newH = Math.max(120, Math.min(window.innerHeight * 0.6, startH + (startY - ev.clientY)));
      dockEl.style.height = newH + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      localStorage.setItem(DOCK_H_KEY, dockEl.offsetHeight);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // ── Timeline brush (drag = range select, click = jump) ──
  const tlBar   = document.getElementById('timeline-bar');
  const tlBrush = document.getElementById('timeline-brush');
  let down = false, x0 = 0, moved = false, selEl = null;

  tlBrush.addEventListener('mousedown', e => {
    if (!allEntries.length) return;
    down = true; moved = false;
    const rect = tlBrush.getBoundingClientRect();
    x0 = e.clientX - rect.left;
    document.querySelector('.timeline-selection')?.remove();
    selEl = document.createElement('div');
    selEl.className = 'timeline-selection';
    selEl.style.left = x0 + 'px';
    selEl.style.width = '0px';
    tlBar.appendChild(selEl);
  });
  window.addEventListener('mousemove', e => {
    if (!down) return;
    const rect = tlBrush.getBoundingClientRect();
    let x1 = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    if (Math.abs(x1 - x0) > 3) moved = true;
    if (selEl) {
      selEl.style.left  = Math.min(x0, x1) + 'px';
      selEl.style.width = Math.abs(x1 - x0) + 'px';
    }
  });
  window.addEventListener('mouseup', e => {
    if (!down) return;
    down = false;
    const rect = tlBrush.getBoundingClientRect();
    const x1 = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const span = tEnd - tStart;
    if (!moved) {
      selEl?.remove(); selEl = null;
      jumpToTime(tStart + (x0 / rect.width) * span);
      return;
    }
    const a = Math.min(x0, x1) / rect.width;
    const b = Math.max(x0, x1) / rect.width;
    rangeStart = tStart + a * span;
    rangeEnd   = tStart + b * span;
    showRangeReadout();
    applyFilters();
  });
  document.getElementById('range-clear').addEventListener('click', clearRange);

  // ── Keyboard: Esc closes dock / dropdown ──
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeDock();
      closeDropdown();
      closeAnalyze();
    }
  });

  // ── Virtual scroll + responsive timeline ──
  logContainer.addEventListener('scroll', scheduleRender, { passive: true });
  window.addEventListener('resize', () => { scheduleRender(); renderTimeline(); }, { passive: true });
});

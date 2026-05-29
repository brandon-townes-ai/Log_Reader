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
let rafId = null;

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
    rowsEl.innerHTML = '';
    return;
  }

  const scrollTop     = container.scrollTop;
  const clientHeight  = container.clientHeight;
  const startIdx = Math.max(0,     Math.floor(scrollTop / ROW_H) - BUFFER);
  const endIdx   = Math.min(total, Math.ceil((scrollTop + clientHeight) / ROW_H) + BUFFER);

  spacerTop.style.height = `${startIdx * ROW_H}px`;
  spacerBot.style.height = `${(total - endIdx) * ROW_H}px`;

  const frag = document.createDocumentFragment();
  for (let i = startIdx; i < endIdx; i++) {
    frag.appendChild(buildRow(displayRows[i], i));
  }

  rowsEl.textContent = '';
  rowsEl.appendChild(frag);
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

// ── Filters ──────────────────────────────────────────────────
function applyFilters() {
  expandedGroups.clear();  // group ids shift when the filtered set changes

  filteredEntries = allEntries.filter(e => {
    if (activeLevels    !== null && !activeLevels.has(canonLevel(e.level))) return false;
    if (activeProcesses !== null && !activeProcesses.has(e.process))        return false;
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

// ── Stats Bar ────────────────────────────────────────────────
function renderStats() {
  const bar = document.getElementById('stats-bar');
  bar.innerHTML = '';
  if (!allEntries.length) return;

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
    chip.className = 'stat-chip stat-chip--level';
    chip.title = `Filter ${lv}`;
    chip.innerHTML =
      `<span class="stat-dot" style="background:${LEVEL_COLORS[lv] || '#94a3b8'}"></span>` +
      `<span class="stat-label">${lv}</span>` +
      `<span class="stat-val">${levelCounts[lv].toLocaleString()}</span>`;
    chip.addEventListener('click', () => toggleLevel(lv));
    frag.appendChild(chip);
  });

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
      el.title = `Filter to ${p}`;
      el.textContent = `${p} ${c.toLocaleString()}`;
      el.addEventListener('click', () => focusProcess(p));
      noisy.appendChild(el);
      noisy.appendChild(document.createTextNode(' '));
    });
    frag.appendChild(noisy);
  }

  bar.appendChild(frag);
}

// Narrow the process filter to a single process (used by stats links)
function focusProcess(p) {
  activeProcesses = new Set([p]);
  const menu = document.getElementById('dropdown-menu');
  menu.querySelectorAll('input').forEach(c => {
    c.checked = c.value === '__ALL__' ? false : c.value === p;
  });
  syncDropdownLabel();
  applyFilters();
}

// ── Timeline histogram ───────────────────────────────────────
function renderTimeline() {
  const canvas = document.getElementById('timeline-canvas');
  const barEl  = document.getElementById('timeline-bar');
  if (!canvas || !barEl || !allEntries.length || tEnd <= tStart) return;

  const w = barEl.clientWidth, h = barEl.clientHeight;
  if (!w || !h) return;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

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
    const lv = canonLevel(displayRows[i].entry.level);
    let color = null;
    if (lv === 'ERROR' || lv === 'FATAL') color = LEVEL_COLORS.ERROR;
    else if (lv === 'WARN')               color = LEVEL_COLORS.WARN;
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

// ── Inspector panel ──────────────────────────────────────────
function openInspector(entry) {
  const body = document.getElementById('inspector-body');
  const fields = [
    ['Timestamp', entry.timestamp],
    ['Process',   entry.process],
    ['Level',     entry.level],
    ['Module',    entry.module],
    ['Source',    entry.source || '—'],
    ['Line #',    entry.line_number],
    ['Message',   entry.message],
  ];
  let html = fields.map(([k, v]) =>
    `<div class="insp-field"><div class="insp-key">${esc(k)}</div>` +
    `<div class="insp-val">${esc(String(v))}</div></div>`
  ).join('');
  html += `<button class="insp-copy" id="insp-copy">COPY RAW</button>`;
  body.innerHTML = html;

  // color the process value to match the row
  const procVal = body.querySelectorAll('.insp-val')[1];
  if (procVal) procVal.style.color = hashColor(entry.process);

  document.getElementById('insp-copy').addEventListener('click', () => {
    navigator.clipboard?.writeText(entry.raw);
    const btn = document.getElementById('insp-copy');
    btn.textContent = 'COPIED ✓';
    setTimeout(() => { btn.textContent = 'COPY RAW'; }, 1200);
  });

  document.getElementById('inspector').classList.remove('hidden');
}

function closeInspector() {
  document.getElementById('inspector').classList.add('hidden');
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
function buildProcessDropdown() {
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

  menu.appendChild(mkItem('__ALL__', 'All processes'));
  processes.forEach(p => {
    const color = hashColor(p);
    menu.appendChild(mkItem(p, `<span style="color:${color}">${esc(p)}</span>`));
  });

  menu.addEventListener('change', e => {
    const allChk   = menu.querySelector('input[value="__ALL__"]');
    const procChks = [...menu.querySelectorAll('input:not([value="__ALL__"])')];

    if (e.target.value === '__ALL__') {
      // "All processes" toggled — sync every process checkbox to match
      const checked = allChk.checked;
      procChks.forEach(c => { c.checked = checked; });
      activeProcesses = checked ? null : null; // empty selection → treat as ALL
      allChk.checked = true; // never allow ALL to be fully unchecked
    } else {
      // A specific process was toggled
      const allSelected  = procChks.every(c => c.checked);
      const noneSelected = procChks.every(c => !c.checked);

      if (allSelected || noneSelected) {
        // Back to all — reset
        procChks.forEach(c => { c.checked = true; });
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

  activeProcesses = null;
  syncDropdownLabel();
}

function syncDropdownLabel() {
  document.getElementById('dropdown-label').textContent =
    activeProcesses === null ? 'All processes' : `${activeProcesses.size} selected`;
}

// ── Upload ───────────────────────────────────────────────────
async function handleUpload(files) {
  if (!files || !files.length) return;
  uploadedFiles = Array.from(files);

  showLoading(true);
  hideError();

  const fd = new FormData();
  uploadedFiles.forEach(f => fd.append('files', f));

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || `Server error ${res.status}`);
    }
    const entries = await res.json();
    showLoading(false);
    loadViewer(entries);
  } catch (err) {
    showLoading(false);
    showError(String(err.message));
  }
}

function loadViewer(entries) {
  // Precompute numeric epoch-ms per entry + dataset bounds (Feature 0)
  for (const e of entries) {
    e._t = Date.parse(e.timestamp.slice(0, 23).replace(' ', 'T'));
  }
  tStart = entries.length ? entries[0]._t : 0;
  tEnd   = entries.length ? entries[0]._t : 0;
  for (const e of entries) {
    if (e._t < tStart) tStart = e._t;
    if (e._t > tEnd)   tEnd   = e._t;
  }

  allEntries      = entries;
  filteredEntries = entries;
  activeLevels    = null;
  activeProcesses = null;
  searchRegex     = null;
  excludeRegex    = null;
  rangeStart      = rangeEnd = null;
  collapseRepeats = false;
  expandedGroups.clear();

  // Reset UI
  document.getElementById('search-input').value = '';
  document.getElementById('exclude-input').value = '';
  document.getElementById('collapse-toggle').classList.remove('active');
  document.getElementById('collapse-toggle').setAttribute('aria-pressed', 'false');
  document.querySelector('.timeline-selection')?.remove();
  showRangeReadout();
  closeInspector();
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

  showViewer();
}

// ── Screen transitions ───────────────────────────────────────
function showViewer() {
  document.getElementById('upload-screen').classList.remove('active');
  document.getElementById('viewer-screen').classList.add('active');
  requestAnimationFrame(() => { renderRows(); renderTimeline(); });
}

function showUpload() {
  document.getElementById('viewer-screen').classList.remove('active');
  document.getElementById('upload-screen').classList.add('active');
  allEntries = filteredEntries = [];
  uploadedFiles = [];
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

async function collectTxtFiles(entry) {
  if (entry.isFile) {
    if (entry.name.endsWith('.txt')) return [await fsEntryToFile(entry)];
    return [];
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    const files = [];
    // readEntries returns ≤100 results per call — loop until empty
    while (true) {
      const batch = await readDirEntries(reader);
      if (!batch.length) break;
      for (const child of batch) {
        if (child.isFile && child.name.endsWith('.txt')) {
          files.push(await fsEntryToFile(child));
        }
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

// ── Upload-screen animated grid canvas ───────────────────────
function initGridCanvas() {
  const canvas = document.getElementById('grid-canvas');
  if (!canvas) return;
  const ctx    = canvas.getContext('2d');
  const CELL   = 48;
  let t        = 0;

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cols = Math.ceil(canvas.width  / CELL) + 1;
    const rows = Math.ceil(canvas.height / CELL) + 1;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const d = Math.hypot(c - cols/2, r - rows/2);
        const pulse = (Math.sin(d * .45 - t * 1.4) + 1) / 2;
        const alpha = pulse * .18 + .03;
        ctx.beginPath();
        ctx.arc(c * CELL, r * CELL, 1, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(240,180,41,${alpha})`;
        ctx.fill();
      }
    }

    t += 0.016;
    if (document.getElementById('upload-screen').classList.contains('active')) {
      requestAnimationFrame(draw);
    }
  }

  window.addEventListener('resize', resize);
  resize();

  // Restart animation whenever upload screen becomes visible
  const observer = new MutationObserver(() => {
    if (document.getElementById('upload-screen').classList.contains('active')) {
      t = 0;
      requestAnimationFrame(draw);
    }
  });
  observer.observe(document.getElementById('upload-screen'), { attributes: true, attributeFilter: ['class'] });
  draw();
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initGridCanvas();

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

  // ── Inspector close ──
  document.getElementById('inspector-close').addEventListener('click', closeInspector);

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

  // ── Keyboard: Esc closes inspector / dropdown ──
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeInspector();
      closeDropdown();
    }
  });

  // ── Virtual scroll + responsive timeline ──
  logContainer.addEventListener('scroll', scheduleRender, { passive: true });
  window.addEventListener('resize', () => { scheduleRender(); renderTimeline(); }, { passive: true });
});

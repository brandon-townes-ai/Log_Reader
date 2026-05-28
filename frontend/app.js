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
let activeLevels    = null;   // null = ALL; else Set<string>
let activeProcesses = null;   // null = ALL; else Set<string>
let searchRegex     = null;   // compiled RegExp | null
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

function compileSearch(raw) {
  const wrap = document.querySelector('.search-wrap');
  if (!raw.trim()) {
    searchRegex = null;
    wrap?.classList.remove('regex-error');
    return;
  }
  try {
    searchRegex = new RegExp(raw, 'i');
    wrap?.classList.remove('regex-error');
  } catch {
    searchRegex = null;
    wrap?.classList.add('regex-error');
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

  const total = filteredEntries.length;

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
    frag.appendChild(buildRow(filteredEntries[i], i));
  }

  rowsEl.textContent = '';
  rowsEl.appendChild(frag);
}

function buildRow(entry, idx) {
  const div = document.createElement('div');
  div.className = `log-row ${idx % 2 === 0 ? 'row-even' : 'row-odd'}`;

  const lvlColor  = LEVEL_COLORS[entry.level] || '#94a3b8';
  const procColor = hashColor(entry.process);
  const isFatal   = entry.level === 'FATAL';

  let html = `<span class="tok-ts">${esc(entry.timestamp)}</span>`;
  html += ` <span class="tok-proc" style="color:${procColor}">[${esc(entry.process)}]</span>`;
  html += `<span class="tok-lvl${isFatal ? ' lvl-fatal' : ''}" style="color:${lvlColor}">[${esc(entry.level)}]</span>`;
  html += `<span class="tok-mod">[${esc(entry.module)}]</span>`;
  if (entry.source) html += `<span class="tok-src">[${esc(entry.source)}]</span>`;
  html += `<span class="tok-msg" style="color:${lvlColor}">${highlight(entry.message, searchRegex)}</span>`;

  div.innerHTML = html;
  return div;
}

// ── Filters ──────────────────────────────────────────────────
function applyFilters() {
  filteredEntries = allEntries.filter(e => {
    if (activeLevels    !== null && !activeLevels.has(e.level))     return false;
    if (activeProcesses !== null && !activeProcesses.has(e.process)) return false;
    if (searchRegex && !searchRegex.test(e.raw)) return false;
    return true;
  });

  updateResultCount();
  document.getElementById('log-container').scrollTop = 0;
  renderRows();
}

function updateResultCount() {
  const el = document.getElementById('result-count');
  el.textContent = filteredEntries.length < allEntries.length
    ? `${filteredEntries.length.toLocaleString()} / ${allEntries.length.toLocaleString()} shown`
    : '';
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
  allEntries      = entries;
  filteredEntries = entries;
  activeLevels    = null;
  activeProcesses = null;
  searchRegex     = null;

  // Reset UI
  document.getElementById('search-input').value = '';
  syncLevelPills();
  buildProcessDropdown();
  updateResultCount();

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
  requestAnimationFrame(renderRows);
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
    pill.addEventListener('click', () => {
      const lv = pill.dataset.level;
      if (lv === 'ALL') {
        activeLevels = null;
      } else {
        if (activeLevels === null) {
          activeLevels = new Set([lv]);
        } else {
          activeLevels.has(lv) ? activeLevels.delete(lv) : activeLevels.add(lv);
          if (activeLevels.size === 0) activeLevels = null;
        }
      }
      syncLevelPills();
      applyFilters();
    });
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

  // ── Search (debounced 150 ms) ──
  let searchTimer;
  document.getElementById('search-input').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      compileSearch(e.target.value);
      applyFilters();
    }, 150);
  });

  // ── Virtual scroll ──
  logContainer.addEventListener('scroll', scheduleRender, { passive: true });
  window.addEventListener('resize', scheduleRender, { passive: true });
});

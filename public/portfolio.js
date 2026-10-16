// Portfolio audits: run the SimplAI agent over a large listings CSV.
// The CSV is split by competitor_group (each client SKU with its
// competitors); every group is sent to the agent as its own conversation,
// a few at a time, with a request for a fixed reply format. The agent does
// all the checking: this file only orchestrates, reads the replies into a
// table, and keeps progress in the browser so a job survives a reload.

const A = window.Ally;
const { esc, el } = A;
const $ = (s, root = document) => root.querySelector(s);

const STORE_KEY = 'ally.portfolio.jobs';
const MAX_JOBS = 5;
const MAX_FILE_BYTES = 20_000_000;
const ROW_H = 48;
const POLL_MS = 2000;
const AGENT_TIMEOUT_MS = 6 * 60_000;
const MAX_ATTEMPTS = 2;

const GROUP_PROMPT = [
  'Audit the listings in this CSV against the Amazon content guidelines.',
  'For each client SKU (is_client = TRUE), reply in exactly this format and nothing else:',
  '',
  'SKU: <sku_id> · Compliance score: <N>/100',
  '| SKU | Field | Rule | Severity | Finding | Fix |',
  '|---|---|---|---|---|---|',
  '| <sku_id> | <field> | <rule ID> | <Critical, Major or Minor> | <what is wrong> | <suggested fix> |',
  '',
  'One table row per finding. Repeat the block for every client SKU.',
].join('\n');

let jobs = loadJobs();
let job = null;              // the job on screen
let running = new Set();     // group keys in flight for the job on screen
let paused = false;
const view = { q: '', status: 'all', rule: null, sort: { key: 'score', dir: 1 }, rows: [], selected: null };

// ---------- persistence ----------
function loadJobs() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; }
}
let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(jobs.slice(0, MAX_JOBS))); }
    catch { toast('Progress could not be saved in this browser (storage full). Keep this tab open.'); }
  }, 400);
}

// ---------- CSV ----------
const isTrue = (v) => /^(true|yes|y|1)$/i.test(String(v || '').trim());
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

function buildJob(name, text) {
  const rows = A.parseCsv(text);
  if (!rows.length) throw new Error('No rows found in this CSV.');
  const cols = Object.keys(rows[0]);
  const hasClientCol = cols.includes('is_client');
  const groups = new Map();
  rows.forEach((r, i) => {
    const key = r.competitor_group || `sku:${r.sku_id || i}`;
    if (!groups.has(key)) groups.set(key, { key, rows: [], clientIds: [] });
    const g = groups.get(key);
    g.rows.push(i);
    if (!hasClientCol || isTrue(r.is_client)) g.clientIds.push(r.sku_id || `row-${i + 1}`);
  });
  const skus = {};
  for (const g of groups.values()) for (const id of g.clientIds) {
    const r = rows.find(x => (x.sku_id || '') === id) || {};
    skus[id] = {
      sku_id: id, brand: r.brand || '', title: r.title || '', group: g.key.startsWith('sku:') ? '' : g.key,
      images: (r.image_urls || '').split(/[|,\s]+/).filter(u => /^https?:\/\//i.test(u)),
      status: 'queued', score: null, findings: [],
    };
  }
  const audited = [...groups.values()].filter(g => g.clientIds.length)
    .map(g => ({ key: g.key, rows: g.rows, clientIds: g.clientIds, status: 'queued', attempts: 0 }));
  const missing = ['sku_id', 'is_client', 'competitor_group', 'title'].filter(c => !cols.includes(c));
  return {
    id: `job-${Date.now().toString(36)}`, name, createdAt: Date.now(), status: 'ready', concurrency: 3,
    header: cols, csvText: text, totalRows: rows.length, groups: audited, skus, missing,
  };
}

const parsed = new Map();
function groupCsv(j, g) {
  if (!parsed.has(j.id)) parsed.set(j.id, A.parseCsv(j.csvText));
  const rows = parsed.get(j.id);
  const lines = [j.header.map(csvCell).join(',')];
  for (const i of g.rows) lines.push(j.header.map(h => csvCell(rows[i][h])).join(','));
  return lines.join('\n');
}

// ---------- talking to the agent ----------
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

function replyText(data, sent) {
  const msgs = A.findMessages(data);
  const turn = msgs && A.toTurns(msgs).pop();
  return (turn && turn.reply) || A.extractReply(data, sent) || '';
}

async function runGroup(j, g) {
  g.status = 'running'; g.error = null; g.attempts = (g.attempts || 0) + 1;
  for (const id of g.clientIds) j.skus[id].status = 'running';
  render();
  try {
    if (!g.cId || !g.mId) {
      const text = groupCsv(j, g);
      const base = j.name.replace(/\.csv$/i, '').replace(/[^\w.-]+/g, '_');
      const file = { name: `${base}__${g.key.replace(/[^\w.-]+/g, '_')}.csv`, text, rows: g.rows.length };
      const url = await A.uploadLink(file) || await A.csvLink(file);
      const message = `${GROUP_PROMPT}\n\nListings CSV (${file.name}, ${file.rows} rows), use as csv_url: ${url}`;
      const sent = await A.api('/api/chat', { method: 'POST', body: JSON.stringify({ message }) });
      g.cId = A.findKey(sent.data, A.ID_KEYS.conv);
      g.mId = A.findKey(sent.data, A.ID_KEYS.msg);
      if (!g.cId || !g.mId) throw new Error('The agent API did not return a conversation id');
      g.message = message;
      A.saveTitle(g.cId, `Portfolio · ${g.key}`);
      saveSoon();
    }
    const deadline = Date.now() + AGENT_TIMEOUT_MS;
    let reply = null;
    while (Date.now() < deadline) {
      const r = await A.api(`/api/poll?cId=${encodeURIComponent(g.cId)}&mId=${encodeURIComponent(g.mId)}`);
      if (r.ready) { reply = replyText(r.data, g.message || ''); break; }
      await sleep(POLL_MS);
    }
    if (reply == null) throw new Error('No reply from the agent after 6 minutes');
    g.reply = reply;
    applyReply(j, g, reply);
    g.status = g.clientIds.some(id => j.skus[id].status === 'unread') ? 'unread' : 'done';
  } catch (err) {
    g.error = err.message;
    const retry = g.attempts < MAX_ATTEMPTS;
    g.status = retry ? 'queued' : 'error';
    if (retry) { g.cId = null; g.mId = null; }
    for (const id of g.clientIds) { j.skus[id].status = retry ? 'queued' : 'error'; j.skus[id].error = err.message; }
  }
  saveSoon();
  render();
}

// ---------- reading the agent's reply ----------
const SEVERITIES = ['critical', 'major', 'minor'];
function normSeverity(v) {
  const s = String(v || '').toLowerCase();
  return SEVERITIES.find(k => s.includes(k)) || (s ? 'minor' : 'minor');
}
const stripMd = (v) => String(v || '').replace(/\*\*|__|`/g, '').trim();

function parseTables(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) continue;
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => stripMd(c));
    const head = cells(lines[i]).map(h => h.toLowerCase());
    const col = (re) => head.findIndex(h => re.test(h));
    const idx = { sku: col(/sku|asin/), field: col(/field|attribute|section/), rule: col(/rule/), sev: col(/sever|priority|impact/), finding: col(/finding|issue|problem|violation|detail/), fix: col(/fix|suggest|recommend|rewrite/) };
    for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
      const c = cells(lines[i]);
      out.push({
        sku: idx.sku >= 0 ? c[idx.sku] : '', field: idx.field >= 0 ? c[idx.field] : '',
        rule: idx.rule >= 0 ? (c[idx.rule].match(A.RULE_RE) || [c[idx.rule]])[0] : (lines[i].match(A.RULE_RE) || [''])[0],
        severity: normSeverity(idx.sev >= 0 ? c[idx.sev] : ''), finding: idx.finding >= 0 ? c[idx.finding] : '', fix: idx.fix >= 0 ? c[idx.fix] : '',
      });
    }
  }
  return out;
}

function applyReply(j, g, reply) {
  const ids = g.clientIds;
  const scores = {};
  for (const m of reply.matchAll(/SKU:\s*\**\s*([A-Za-z0-9._-]+)[^\n]*?score[^\d\n]{0,20}(\d{1,3}(?:\.\d+)?)/gi)) scores[m[1]] = Math.min(100, Number(m[2]));
  const rows = parseTables(reply);
  for (const id of ids) {
    const s = j.skus[id];
    let score = scores[id];
    if (score == null && ids.length === 1) score = A.detectScore(reply)?.after ?? null;
    const mine = rows.filter(r => (r.sku ? r.sku.includes(id) : ids.length === 1));
    s.score = score ?? null;
    s.findings = mine.map(({ sku, ...f }) => f);
    s.status = s.score == null && !s.findings.length ? 'unread' : 'done';
    s.error = s.status === 'unread' ? "Couldn't read a score or findings in the agent's reply" : null;
  }
}

// ---------- job control ----------
function pump() {
  if (!job || paused || job.status !== 'running') return;
  const limit = job.concurrency || 3;
  for (const g of job.groups) {
    if (running.size >= limit) break;
    if (g.status !== 'queued' || running.has(g.key)) continue;
    running.add(g.key);
    const j = job;
    runGroup(j, g).finally(() => { running.delete(g.key); if (j === job) { checkDone(); pump(); } });
  }
  checkDone();
}

function checkDone() {
  if (!job || job.status !== 'running') return;
  if (job.groups.every(g => ['done', 'error', 'unread'].includes(g.status))) { job.status = 'done'; saveSoon(); render(); A.loadHistory?.(); }
}

function start() { job.status = 'running'; paused = false; saveSoon(); render(); pump(); }
function pause() { paused = true; job.status = 'paused'; saveSoon(); render(); }
function resume() { job.status = 'running'; paused = false; for (const g of job.groups) if (g.status === 'running' && !running.has(g.key)) g.status = 'queued'; saveSoon(); render(); pump(); }
function retryFailed() {
  for (const g of job.groups) if (g.status === 'error' || g.status === 'unread') { g.status = 'queued'; g.attempts = 0; g.cId = null; g.mId = null; for (const id of g.clientIds) job.skus[id].status = 'queued'; }
  start();
}

// ---------- entry points ----------
async function openFile(file) {
  if (!file) return;
  if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') return toast(`${file.name} isn't a CSV file.`);
  if (file.size > MAX_FILE_BYTES) return toast(`${file.name} is larger than 20 MB.`);
  try {
    const text = (await file.text()).replace(/\r\n?/g, '\n').trim();
    const j = buildJob(file.name, text);
    jobs.unshift(j); jobs = jobs.slice(0, MAX_JOBS);
    saveSoon();
    show(j);
  } catch (err) { toast(err.message); }
}

function show(j) {
  if (job && job !== j && job.status === 'running') { /* other job keeps its in-flight groups; new ones start on return */ }
  job = j; running = new Set(); paused = job.status === 'paused';
  view.q = ''; view.status = 'all'; view.rule = null; view.selected = null;
  // Groups left "running" by a reload resume polling their conversation.
  for (const g of job.groups) if (g.status === 'running') g.status = 'queued';
  $('#app').classList.add('pf-mode');
  $('#app').classList.remove('has-summary');
  $('#chatTitle').textContent = `Portfolio · ${job.name}`;
  A.closeDrawers();
  build();
  render();
  if (job.status === 'running') pump();
}

// ---------- rendering ----------
const scoreBand = (v) => v == null ? 'none' : v >= 85 ? 'good' : v >= 60 ? 'work' : 'risk';
const BAND_LABEL = { good: 'Good', work: 'Needs work', risk: 'At risk', none: '' };
const STATUS_LABEL = { queued: 'Queued', running: 'Auditing…', done: '', unread: 'Check reply', error: 'Failed' };

function build() {
  const root = $('#portfolio');
  root.innerHTML = `
    <div class="pf-head">
      <div class="pf-title"><h1>${esc(job.name)}</h1><p class="muted" id="pfMeta"></p></div>
      <div class="pf-actions" id="pfActions"></div>
    </div>
    <div class="pf-warn hidden" id="pfWarn"></div>
    <div class="pf-progress" id="pfProgress"><div class="pf-bar"><span id="pfBar"></span></div><span class="muted small" id="pfProgressText"></span></div>
    <div class="pf-stats" id="pfStats"></div>
    <div class="pf-rules" id="pfRules"></div>
    <div class="pf-toolbar">
      <input type="search" id="pfSearch" placeholder="Search SKU, brand, title or rule…" autocomplete="off">
      <div class="pf-filters" id="pfFilters"></div>
      <span class="muted small" id="pfCount"></span>
    </div>
    <div class="pf-table" role="table">
      <div class="pf-row pf-header" role="row" id="pfHeader"></div>
      <div class="pf-viewport" id="pfViewport"><div class="pf-spacer" id="pfSpacer"></div></div>
    </div>
    <aside class="pf-drawer" id="pfDrawer" aria-hidden="true"></aside>`;
  const cols = [['sku_id', 'SKU'], ['product', 'Product'], ['group', 'Group'], ['score', 'Score'], ['issues', 'Issues'], ['status', 'Status']];
  $('#pfHeader').innerHTML = cols.map(([k, l]) => `<button class="pf-cell pf-h" data-sort="${k}" role="columnheader">${l}<i></i></button>`).join('');
  $('#pfHeader').onclick = (e) => {
    const k = e.target.closest('[data-sort]')?.dataset.sort; if (!k) return;
    view.sort = { key: k, dir: view.sort.key === k ? -view.sort.dir : 1 }; render();
  };
  $('#pfSearch').oninput = (e) => { view.q = e.target.value.trim().toLowerCase(); render(); };
  $('#pfViewport').onscroll = () => drawRows();
  $('#pfViewport').onclick = (e) => { const r = e.target.closest('[data-sku]'); if (r) openDrawer(r.dataset.sku); };
  $('#pfRules').onclick = (e) => { const r = e.target.closest('[data-rule]'); if (r) { view.rule = view.rule === r.dataset.rule ? null : r.dataset.rule; render(); } };
  $('#pfFilters').onclick = (e) => { const b = e.target.closest('[data-filter]'); if (b) { view.status = b.dataset.filter; render(); } };
  new ResizeObserver(() => drawRows()).observe($('#pfViewport'));
}

let frame = 0;
function render() {
  if (!job || !$('#pfViewport')) return;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(renderNow);
}

function renderNow() {
  const skus = Object.values(job.skus);
  const done = skus.filter(s => s.status === 'done');
  const gDone = job.groups.filter(g => ['done', 'error', 'unread'].includes(g.status)).length;
  const gErr = job.groups.filter(g => g.status === 'error' || g.status === 'unread').length;

  $('#pfMeta').textContent = `${job.totalRows.toLocaleString()} listings · ${skus.length.toLocaleString()} client SKUs · ${job.groups.length.toLocaleString()} competitor groups`;
  const warn = $('#pfWarn');
  warn.classList.toggle('hidden', !job.missing?.length);
  if (job.missing?.length) warn.textContent = `Missing column${job.missing.length > 1 ? 's' : ''}: ${job.missing.join(', ')}. ${job.missing.includes('competitor_group') ? 'Each client SKU will be audited on its own.' : ''}`;

  // Actions
  const act = [];
  if (job.status === 'ready') act.push(`<label class="pf-conc">Parallel <select id="pfConc">${[1, 2, 3, 4, 5].map(n => `<option ${n === job.concurrency ? 'selected' : ''}>${n}</option>`).join('')}</select></label><button class="btn btn-primary" id="pfRun">Run audit</button>`);
  if (job.status === 'running') act.push('<button class="btn" id="pfPause">Pause</button>');
  if (job.status === 'paused') act.push('<button class="btn btn-primary" id="pfResume">Resume</button>');
  if (job.status === 'done' && gErr) act.push(`<button class="btn" id="pfRetry">Retry ${gErr} failed</button>`);
  const filtered = view.q || view.rule || view.status !== 'all';
  if (done.length) act.push(`<button class="btn" id="pfExport" title="Exports the rows currently shown">${filtered ? `Export ${filterSort(skus).length} SKUs` : 'Export CSV'}</button>`);
  $('#pfActions').innerHTML = act.join('');
  $('#pfRun')?.addEventListener('click', start);
  $('#pfConc')?.addEventListener('change', (e) => { job.concurrency = Number(e.target.value); saveSoon(); });
  $('#pfPause')?.addEventListener('click', pause);
  $('#pfResume')?.addEventListener('click', resume);
  $('#pfRetry')?.addEventListener('click', retryFailed);
  $('#pfExport')?.addEventListener('click', exportCsv);

  // Progress
  const pct = job.groups.length ? Math.round((gDone / job.groups.length) * 100) : 0;
  $('#pfProgress').classList.toggle('hidden', job.status === 'ready');
  $('#pfBar').style.width = `${pct}%`;
  const inFlight = job.groups.filter(g => g.status === 'running').length;
  $('#pfProgressText').textContent = job.status === 'done'
    ? `Audit complete · ${gDone} of ${job.groups.length} groups${gErr ? ` · ${gErr} need attention` : ''}`
    : `${gDone} of ${job.groups.length} groups audited${inFlight ? ` · ${inFlight} in progress` : ''}${job.status === 'paused' ? ' · paused' : ''}${gErr ? ` · ${gErr} failed` : ''}`;

  // Stats
  const scored = done.filter(s => s.score != null);
  const avg = scored.length ? Math.round(scored.reduce((a, s) => a + s.score, 0) / scored.length) : null;
  const band = (b) => scored.filter(s => scoreBand(s.score) === b).length;
  const crit = done.reduce((n, s) => n + s.findings.filter(f => f.severity === 'critical').length, 0);
  $('#pfStats').innerHTML = job.status === 'ready'
    ? `<div class="pf-stat"><b>${skus.length}</b><span>client SKUs to audit</span></div><div class="pf-stat"><b>${job.groups.length}</b><span>agent runs (one per group)</span></div><div class="pf-stat"><b>~${Math.max(1, Math.ceil(job.groups.length / job.concurrency))} min</b><span>rough estimate at ${job.concurrency} in parallel</span></div>`
    : `<div class="pf-stat"><b class="${scoreBand(avg)}">${avg ?? '–'}</b><span>average score</span></div>
       <div class="pf-stat"><b class="risk">${band('risk')}</b><span>at risk (&lt;60)</span></div>
       <div class="pf-stat"><b class="work">${band('work')}</b><span>needs work (60–84)</span></div>
       <div class="pf-stat"><b class="good">${band('good')}</b><span>good (85+)</span></div>
       <div class="pf-stat"><b>${crit}</b><span>critical findings</span></div>`;

  // Top failing rules
  const ruleCount = {};
  for (const s of done) for (const r of new Set(s.findings.map(f => f.rule).filter(Boolean))) ruleCount[r] = (ruleCount[r] || 0) + 1;
  const top = Object.entries(ruleCount).sort((a, b) => b[1] - a[1]).slice(0, 8);
  $('#pfRules').innerHTML = top.length ? `<span class="muted small">Most failed rules</span>${top.map(([r, n]) => `<button class="pf-rule ${view.rule === r ? 'on' : ''}" data-rule="${esc(r)}">${esc(r.replace(/^AMZ-/, ''))}<span>${n}</span></button>`).join('')}` : '';

  // Filters
  const counts = { all: skus.length, risk: band('risk'), work: band('work'), good: band('good'), issues: skus.filter(s => ['error', 'unread'].includes(s.status)).length };
  const filters = [['all', 'All'], ['risk', 'At risk'], ['work', 'Needs work'], ['good', 'Good'], ['issues', 'Failed']].filter(([k]) => k === 'all' || counts[k]);
  $('#pfFilters').innerHTML = filters.map(([k, l]) => `<button class="pf-filter ${view.status === k ? 'on' : ''}" data-filter="${k}">${l} <span>${counts[k]}</span></button>`).join('')
    + (view.rule ? `<button class="pf-filter on" data-rule-clear>${esc(view.rule)} ✕</button>` : '');
  $('#pfFilters [data-rule-clear]')?.addEventListener('click', () => { view.rule = null; render(); });

  // Rows
  view.rows = filterSort(skus);
  $('#pfCount').textContent = view.rows.length === skus.length ? '' : `${view.rows.length} of ${skus.length}`;
  document.querySelectorAll('#pfHeader [data-sort]').forEach(h => h.classList.toggle('sorted', h.dataset.sort === view.sort.key));
  $('#pfHeader').dataset.dir = view.sort.dir > 0 ? 'asc' : 'desc';
  $('#pfSpacer').style.height = `${view.rows.length * ROW_H}px`;
  drawRows(true);
  if (view.selected) drawDrawer();
  renderJobList();
}

function filterSort(skus) {
  const q = view.q;
  let rows = skus.filter(s => {
    if (view.status === 'issues' && !['error', 'unread'].includes(s.status)) return false;
    if (['risk', 'work', 'good'].includes(view.status) && (s.status !== 'done' || scoreBand(s.score) !== view.status)) return false;
    if (view.rule && !s.findings.some(f => f.rule === view.rule)) return false;
    if (q && !`${s.sku_id} ${s.brand} ${s.title} ${s.group} ${s.findings.map(f => f.rule).join(' ')}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const { key, dir } = view.sort;
  const val = (s) => key === 'score' ? (s.score ?? 999) : key === 'issues' ? -(s.findings.filter(f => f.severity === 'critical').length * 100 + s.findings.length)
    : key === 'product' ? `${s.brand} ${s.title}`.toLowerCase() : key === 'status' ? s.status : String(s[key] || '').toLowerCase();
  rows.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
  return rows;
}

let lastRange = '';
function drawRows(force) {
  const vp = $('#pfViewport'); if (!vp) return;
  const first = Math.max(0, Math.floor(vp.scrollTop / ROW_H) - 6);
  const last = Math.min(view.rows.length, Math.ceil((vp.scrollTop + vp.clientHeight) / ROW_H) + 6);
  const range = `${first}-${last}`;
  if (!force && range === lastRange) return;
  lastRange = range;
  vp.querySelectorAll('.pf-row').forEach(r => r.remove());
  const frag = document.createDocumentFragment();
  for (let i = first; i < last; i++) frag.appendChild(rowEl(view.rows[i], i));
  vp.appendChild(frag);
}

// Titles usually start with the brand, which is already shown in bold.
const shortTitle = (s) => (s.brand && s.title?.toLowerCase().startsWith(s.brand.toLowerCase()) ? s.title.slice(s.brand.length).replace(/^[\s,:–-]+/, '') : s.title) || '';

function rowEl(s, i) {
  const r = el('div', `pf-row${view.selected === s.sku_id ? ' selected' : ''}`);
  r.style.top = `${i * ROW_H}px`;
  r.dataset.sku = s.sku_id;
  r.setAttribute('role', 'row');
  const sev = (k) => s.findings.filter(f => f.severity === k).length;
  const b = scoreBand(s.score);
  const scoreCell = s.status === 'done' && s.score != null
    ? `<span class="pf-score ${b}"><b>${Math.round(s.score)}</b><i style="--v:${s.score}"></i></span>` : '<span class="muted">–</span>';
  const issues = s.status === 'done' ? (s.findings.length
    ? ['critical', 'major', 'minor'].filter(k => sev(k)).map(k => `<span class="pf-sev ${k}" title="${sev(k)} ${k}">${sev(k)}</span>`).join('')
    : '<span class="muted small">None reported</span>') : '';
  const st = s.status === 'done' ? BAND_LABEL[b] : STATUS_LABEL[s.status];
  r.innerHTML = `<span class="pf-cell mono">${esc(s.sku_id)}</span>
    <span class="pf-cell pf-product" title="${esc(s.title || '')}"><b>${esc(s.brand || '')}</b> <span class="muted">${esc(shortTitle(s))}</span></span>
    <span class="pf-cell muted small">${esc(s.group || '–')}</span>
    <span class="pf-cell">${scoreCell}</span>
    <span class="pf-cell">${issues}</span>
    <span class="pf-cell"><span class="pf-status ${s.status === 'done' ? b : s.status}">${st || ''}</span></span>`;
  return r;
}

// ---------- detail drawer ----------
function openDrawer(id) { view.selected = id; drawRows(true); drawDrawer(); }
function closeDrawer() { view.selected = null; $('#pfDrawer')?.classList.remove('open'); drawRows(true); }

function drawDrawer() {
  const s = job.skus[view.selected]; const d = $('#pfDrawer');
  if (!s || !d) return;
  const g = job.groups.find(x => x.clientIds.includes(s.sku_id));
  const b = scoreBand(s.score);
  const sorted = [...s.findings].sort((x, y) => SEVERITIES.indexOf(x.severity) - SEVERITIES.indexOf(y.severity));
  d.innerHTML = `
    <div class="pf-d-head">
      <div><div class="mono small muted">${esc(s.sku_id)}${s.group ? ` · ${esc(s.group)}` : ''}</div><h2>${esc(s.brand || s.sku_id)}</h2><p class="muted small">${esc(s.title || '')}</p></div>
      <button class="icon-btn" id="pfClose" aria-label="Close">✕</button>
    </div>
    ${s.status === 'done' && s.score != null ? `<div class="pf-d-score ${b}"><b>${Math.round(s.score)}</b><span>/100 · ${BAND_LABEL[b]}</span></div>` : ''}
    ${s.error ? `<p class="pf-d-error">${esc(s.error)}</p>` : ''}
    ${['queued', 'running'].includes(s.status) ? `<p class="muted">${s.status === 'running' ? 'The agent is auditing this group…' : 'Waiting to be audited.'}</p>` : ''}
    ${sorted.length ? `<h3>Findings <span class="count">${sorted.length}</span></h3><div class="pf-findings">${sorted.map(f => `
      <div class="pf-finding">
        <div class="pf-f-top"><span class="sev ${f.severity}">${f.severity}</span>${f.field ? `<b>${esc(f.field)}</b>` : ''}${f.rule ? `<span class="rule" data-rule="${esc(f.rule)}">${esc(f.rule)}</span>` : ''}</div>
        ${f.finding ? `<div>${esc(f.finding)}</div>` : ''}
        ${f.fix ? `<div class="muted small"><b>Fix:</b> ${esc(f.fix)}</div>` : ''}
      </div>`).join('')}</div>` : s.status === 'done' ? '<p class="muted">The agent reported no findings for this SKU.</p>' : ''}
    <div class="pf-d-actions">
      ${g?.cId ? '<button class="btn btn-primary" id="pfChat">Continue with Ally</button>' : ''}
      ${s.images.length ? `<button class="btn" id="pfImages">Check ${s.images.length} image${s.images.length === 1 ? '' : 's'}</button>` : ''}
      ${g && ['done', 'error', 'unread'].includes(g.status) ? '<button class="btn" id="pfRerun">Re-run group</button>' : ''}
    </div>
    <div id="pfImageResult"></div>
    ${g?.reply ? `<details class="pf-raw"><summary>Agent's reply</summary><pre>${esc(g.reply)}</pre></details>` : ''}`;
  d.classList.add('open');
  $('#pfClose').onclick = closeDrawer;
  $('#pfChat')?.addEventListener('click', () => A.openConversation(g.cId, `Portfolio · ${s.brand || s.sku_id}`));
  $('#pfRerun')?.addEventListener('click', () => {
    g.status = 'queued'; g.attempts = 0; g.cId = null; g.mId = null;
    for (const id of g.clientIds) job.skus[id].status = 'queued';
    if (job.status !== 'running') job.status = 'running';
    paused = false; saveSoon(); render(); pump();
  });
  $('#pfImages')?.addEventListener('click', () => checkImages(s));
  if (s.imageResult) drawImages(s.imageResult);
}

async function checkImages(s) {
  const box = $('#pfImageResult');
  box.innerHTML = '<div class="thinking"><span class="dots"><i></i><i></i><i></i></span><span>Checking images…</span></div>';
  try {
    const res = await fetch('/api/images', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku_id: s.sku_id, title: s.brand || s.title, image_urls: s.images }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    s.imageResult = body; saveSoon();
    if (view.selected === s.sku_id) drawImages(body);
  } catch (err) { box.innerHTML = `<p class="pf-d-error">Image check failed: ${esc(err.message)}</p>`; }
}

function drawImages(r) {
  const box = $('#pfImageResult'); if (!box) return;
  box.innerHTML = '<h3>Images</h3>';
  for (const c of r.listingChecks) box.appendChild(el('p', 'listing-check', `${A.statusIcon(c.status)} <b>${esc(c.label)}</b> <span class="muted">· ${esc(c.detail)}</span>`));
  const grid = el('div', 'img-grid pf-img-grid');
  for (const img of r.images) grid.appendChild(A.imageCard(img));
  box.appendChild(grid);
  if (r.aiNote) box.appendChild(el('p', 'muted small', esc(r.aiNote)));
}

// ---------- export ----------
function exportCsv() {
  const head = ['sku_id', 'brand', 'competitor_group', 'score', 'status', 'severity', 'field', 'rule', 'finding', 'fix'];
  const lines = [head.join(',')];
  for (const s of filterSort(Object.values(job.skus))) {
    const base = [s.sku_id, s.brand, s.group, s.score ?? '', s.status === 'done' ? BAND_LABEL[scoreBand(s.score)] : s.status];
    if (!s.findings.length) lines.push([...base, '', '', '', '', ''].map(csvCell).join(','));
    for (const f of s.findings) lines.push([...base, f.severity, f.field, f.rule, f.finding, f.fix].map(csvCell).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = el('a'); a.href = URL.createObjectURL(blob);
  a.download = `${job.name.replace(/\.csv$/i, '')}-audit-results.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- sidebar ----------
function renderJobList() {
  const list = $('#pfJobs'); if (!list) return;
  $('#pfSideLabel').classList.toggle('hidden', !jobs.length);
  list.innerHTML = '';
  for (const j of jobs) {
    const done = j.groups.filter(g => ['done', 'error', 'unread'].includes(g.status)).length;
    const li = el('li');
    const label = j.status === 'done' ? `${Object.keys(j.skus).length} SKUs audited` : j.status === 'ready' ? 'Not started' : `${done}/${j.groups.length} groups${j.status === 'paused' ? ' · paused' : ''}`;
    const btn = el('button', j === job && $('#app').classList.contains('pf-mode') ? 'active' : '', `<span class="h-title">${esc(j.name)}</span><span class="h-date">${label}</span>`);
    btn.onclick = () => show(j);
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function toast(msg) {
  const t = el('div', 'pf-toast', esc(msg));
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

window.Portfolio = { openFile };
renderJobList();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && view.selected) closeDrawer(); });

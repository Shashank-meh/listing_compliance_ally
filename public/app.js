// Listing Compliance Ally — chat client.
// Talks to the local proxy (server.js), which forwards to the SimplAI agent API.

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 180_000;
const RULE_RE = /\bAMZ-[A-Z]+-\d{1,3}\b/g;

const STARTERS = [
  { tag: 'Audit', title: 'Audit PawJoy', desc: 'Dog chew toy · score, findings, fixes',
    prompt: 'Audit the PawJoy dog chew toy listing against the Amazon content guidelines. Give me the compliance score, findings by field with rule ID and severity, and a suggested fix for each.' },
  { tag: 'Audit', title: 'Audit FizzWave', desc: 'Sparkling water · score, findings, fixes',
    prompt: 'Audit the FizzWave sparkling water listing against the Amazon content guidelines. Give me the compliance score, findings by field with rule ID and severity, and a suggested fix for each.' },
  { tag: 'Benchmark', title: 'Compare with competitors', desc: 'Client vs competitor median on six measures',
    prompt: 'Benchmark PawJoy against its 3 competitors: score, image count, headed bullets, description depth, and the themes competitors cover. Flag any risky claims competitors make.' },
  { tag: 'Full flow', title: 'Audit → rewrite → sign-off', desc: 'Everything a brand manager needs to approve',
    prompt: 'Run the full flow for FizzWave: audit, competitor benchmark, a compliant rewrite of the title, bullets and description with a rule ID on every change, the verified score before and after, the confirm-with-brand list, and the image plan.' },
];

const FOLLOWUPS = [
  { label: 'Show the compliant rewrite', prompt: 'Show the compliant rewrite of the title, 5 bullets and description, with the rule ID for each change.' },
  { label: 'Benchmark vs competitors', prompt: 'How does this listing compare with its competitors? Show the client against the competitor median.' },
  { label: 'Score before → after', prompt: 'Re-score the rewrite with the rule engine and show the score before and after.' },
  { label: 'What to confirm with the brand', prompt: 'List the facts the rewrite needs but the data does not hold, so I can confirm them with the brand.' },
  { label: 'Image plan', prompt: 'Give me the image plan: the shots needed to reach 5–7 images.' },
  { label: 'Only critical issues', prompt: 'Show only the critical findings and how to fix them.' },
];

const state = {
  conversationId: null,
  busy: false,
  abort: null,
  asked: new Set(),
  ruleCounts: new Map(),
  score: null,
};

// ---------- response parsing (tolerant of unknown shapes) ----------
const ID_KEYS = { conv: /^(conversation_?id|conversationId|c_?id)$/i, msg: /^(message_?id|messageId|m_?id)$/i };
const REPLY_KEYS = ['agent_response', 'final_response', 'response_text', 'response', 'answer', 'reply', 'output', 'bot_response', 'result', 'content', 'text', 'message'];

function bfs(root, visit) {
  const queue = [[root, null, []]];
  const seen = new Set();
  while (queue.length) {
    const [node, key, path] = queue.shift();
    if (node && typeof node === 'object') {
      if (seen.has(node)) continue;
      seen.add(node);
      for (const [k, v] of Object.entries(node)) {
        if (visit(v, k, path) === true) return;
        queue.push([v, k, [...path, k]]);
      }
    }
  }
}
function findKey(root, re) {
  let found = null;
  bfs(root, (v, k) => { if (re.test(k) && (typeof v === 'string' || typeof v === 'number') && v !== '') { found = String(v); return true; } });
  return found;
}
function extractReply(root, exclude = '') {
  if (typeof root === 'string') return tryJsonReply(root) ?? root;
  let best = null;
  bfs(root, (v, k, path) => {
    if (typeof v !== 'string' || !v.trim() || v === exclude) return;
    if (path.some(p => /^(query|request|user_?message|question)$/i.test(p))) return;
    const pri = REPLY_KEYS.indexOf(String(k).toLowerCase());
    if (pri < 0) return;
    if (!best || pri < best.pri || (pri === best.pri && v.length > best.v.length)) best = { v, pri };
  });
  if (!best) return null;
  return tryJsonReply(best.v) ?? best.v;
}
function tryJsonReply(s) {
  const t = s.trim();
  if (!/^[{[]/.test(t)) return null;
  try { const o = JSON.parse(t); const r = extractReply(o); return r && r !== s ? r : null; } catch { return null; }
}
function findArray(root) {
  if (Array.isArray(root)) return root;
  let arr = null;
  bfs(root, (v) => { if (Array.isArray(v) && v.some(x => x && typeof x === 'object')) { arr = v; return true; } });
  return arr || [];
}
function extractUserText(item) {
  const q = item.query ?? item.request;
  if (typeof q === 'string') return q;
  if (q && typeof q === 'object') return findKey(q, /^(message|text|content)$/i);
  return findKey(item, /^(user_?message|question|user_?query|prompt)$/i);
}

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const detail = body?.detail || body?.error || findKey(body?.data, /^(message|error|detail)$/i) || res.statusText;
    throw Object.assign(new Error(`${res.status} · ${detail}`), { body });
  }
  return body;
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

// ---------- rendering ----------
function renderMarkdown(text) {
  let html;
  if (window.marked && window.DOMPurify) {
    html = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }), { ADD_TAGS: ['ins'] });
  } else {
    html = `<p>${esc(text).replace(/\n/g, '<br>')}</p>`;
  }
  const wrap = el('div', 'md', html);
  wrap.querySelectorAll('table').forEach(t => { const w = el('div', 'table-wrap'); t.replaceWith(w); w.appendChild(t); });
  wrap.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
  decorate(wrap);
  return wrap;
}

// Turns rule IDs into clickable chips and severity labels into badges.
function decorate(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.parentElement.closest('code, pre, .rule, .sev') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const SEV_RE = /[[(](critical|major|minor)[\])]/gi;
  for (const node of nodes) {
    const t = node.nodeValue;
    const cell = node.parentElement.closest('td');
    const cellSev = cell && cell.textContent.trim().match(/^(critical|major|minor|pass(ed)?)$/i);
    if (cellSev && node.parentElement === cell) {
      const k = cellSev[1].toLowerCase().startsWith('pass') ? 'pass' : cellSev[1].toLowerCase();
      cell.innerHTML = `<span class="sev ${k}">${esc(cell.textContent.trim())}</span>`;
      continue;
    }
    if (!RULE_RE.test(t) && !SEV_RE.test(t)) continue;
    RULE_RE.lastIndex = 0; SEV_RE.lastIndex = 0;
    const html = esc(t)
      .replace(RULE_RE, id => `<button class="rule" data-rule="${id}" title="Ask about ${id}">${id}</button>`)
      .replace(SEV_RE, (m, s) => `<span class="sev ${s.toLowerCase()}">${s}</span>`);
    const span = document.createElement('span');
    span.innerHTML = html;
    node.replaceWith(...span.childNodes);
  }
}

function hideWelcome() { $('#welcome')?.classList.add('hidden'); }
function scrollDown() { const t = $('#thread'); t.scrollTop = t.scrollHeight; }

// The CSV is sent as a link (see csvLink); in the thread it shows as a file chip.
// CSV_BLOCK_RE also matches older messages that inlined the CSV text.
const CSV_LINK_RE = /\s*Listings CSV \(([^)]*)\):\s*(https?:\/\/\S+)\s*$/;
const CSV_BLOCK_RE = /\s*Listings CSV \(([^)]*)\):\s*```(?:csv)?\s*([\s\S]*?)\s*```\s*$/;
const stripCsv = (t) => t.replace(CSV_LINK_RE, '').replace(CSV_BLOCK_RE, '').trim();
const hasCsv = (t) => CSV_LINK_RE.test(t) || CSV_BLOCK_RE.test(t);

function fileChip(name, meta, onRemove, href) {
  const chip = el(href ? 'a' : 'div', 'file-chip', `<span class="fi">CSV</span><span class="fn">${esc(name)}</span><span class="fm">${esc(meta)}</span>`);
  if (onRemove) {
    const x = el('button', '', '✕'); x.type = 'button'; x.title = 'Remove'; x.onclick = onRemove;
    chip.appendChild(x);
  }
  if (href) { chip.href = href; chip.target = '_blank'; chip.rel = 'noopener'; chip.title = 'Open the CSV the agent received'; }
  return chip;
}

function addUser(text) {
  hideWelcome();
  const m = el('div', 'msg user');
  const stack = el('div', 'stack');
  const link = text.match(CSV_LINK_RE);
  const block = !link && text.match(CSV_BLOCK_RE);
  const csv = link || block;
  const shown = csv ? text.slice(0, csv.index).trim() : text;
  if (csv) {
    const [name, size] = csv[1].split(',').map(s => s.trim());
    stack.appendChild(fileChip(name || 'listings.csv', size || (block ? `${csvRows(block[2])} rows` : ''), null, link ? link[2] : null));
  }
  if (shown) stack.appendChild(el('div', 'bubble')).textContent = shown;
  m.appendChild(stack);
  $('#thread').appendChild(m);
  scrollDown();
}

// ---------- CSV attachment ----------
const MAX_CSV_BYTES = 300_000;

function csvRows(text) {
  // Count records, ignoring newlines inside quoted fields; minus the header.
  let rows = 0, inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inQ = !inQ;
    else if (c === '\n' && !inQ) rows++;
  }
  if (text.length && !text.endsWith('\n')) rows++;
  return Math.max(rows - 1, 0);
}

async function attachFile(file) {
  if (!file) return;
  if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') return toast(`${file.name} isn't a CSV file.`);
  if (file.size > MAX_CSV_BYTES) return toast(`${file.name} is ${Math.round(file.size / 1024)} KB. Keep it under ${MAX_CSV_BYTES / 1000} KB, or split it by competitor group.`);
  const text = (await file.text()).replace(/\r\n?/g, '\n').trim();
  state.file = { name: file.name, text, rows: csvRows(text) };
  renderAttachment();
  if (state.pendingPrompt) { const p = state.pendingPrompt; state.pendingPrompt = null; send(p); }
  else $('#input').focus();
}

function renderAttachment() {
  const box = $('#attached');
  box.innerHTML = '';
  const f = state.file;
  box.classList.toggle('hidden', !f);
  const dz = $('#dropzone');
  dz.classList.toggle('has-file', !!f);
  $('#dropzoneSub').textContent = f
    ? `${f.name} · ${f.rows} listings attached. Pick a flow below or ask anything.`
    : 'Drop it here or click to choose · title, bullets, description, image URLs, is_client, competitor_group';
  if (f) box.appendChild(fileChip(f.name, `${f.rows} listings`, () => { state.file = null; renderAttachment(); }));
}

// Packs the CSV into a URL on this site (gzip + base64url) that serves it back
// as text/csv, so the agent's ingest step can fetch it like any hosted file.
const MAX_LINK_CHARS = 12_000;
async function csvLink(f) {
  const gz = await new Response(new Blob([f.text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const bytes = new Uint8Array(gz);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const z = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const name = f.name.replace(/[^\w.-]/g, '_').replace(/(\.csv)?$/i, '.csv');
  const url = `${location.origin}/f/${z}/${name}`;
  if (url.length > MAX_LINK_CHARS) throw new Error(`${f.name} is too large to link (${Math.round(url.length / 1000)}k characters compressed). Split it by competitor group and try again.`);
  return url;
}

function pickFile(thenPrompt) {
  state.pendingPrompt = thenPrompt || null;
  $('#fileInput').value = '';
  $('#fileInput').click();
}

function toast(msg) {
  const box = $('#attached');
  box.classList.remove('hidden');
  const t = el('div', 'file-chip error', esc(msg));
  box.appendChild(t);
  setTimeout(() => { t.remove(); if (!state.file) box.classList.add('hidden'); }, 5000);
}

const AVATAR = '<div class="avatar" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4"/><path d="M12 3l7 4v5c0 4.5-3 8-7 9-4-1-7-4.5-7-9V7z"/></svg></div>';

function addBot() {
  hideWelcome();
  const m = el('div', 'msg bot', AVATAR);
  const body = el('div', 'body');
  const card = el('div', 'card');
  body.appendChild(card);
  m.appendChild(body);
  $('#thread').appendChild(m);
  scrollDown();
  return { m, body, card };
}

function setThinking(card, startedAt) {
  const secs = Math.round((Date.now() - startedAt) / 1000);
  const label = secs < 4 ? 'Ally is reading your request…' : secs < 20 ? 'Checking the listing against the rules…' : 'Still working — full audits can take a minute…';
  card.innerHTML = `<div class="thinking"><span class="dots"><i></i><i></i><i></i></span><span>${label}</span><span class="small">${secs}s</span></div>`;
}

function fillBot(view, text, raw) {
  view.card.innerHTML = '';
  view.card.appendChild(renderMarkdown(text));
  const tools = el('div', 'msg-tools');
  const copy = el('button', '', 'Copy');
  copy.onclick = async () => { try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; setTimeout(() => copy.textContent = 'Copy', 1200); } catch { /* clipboard blocked */ } };
  tools.appendChild(copy);
  if (raw !== undefined) {
    const rawBtn = el('button', '', 'Raw response');
    let pre;
    rawBtn.onclick = () => {
      if (pre) { pre.remove(); pre = null; return; }
      pre = el('pre', 'raw'); pre.textContent = JSON.stringify(raw, null, 2); view.body.appendChild(pre);
    };
    tools.appendChild(rawBtn);
  }
  view.body.appendChild(tools);
  absorb(text);
}

function showError(view, err, retry) {
  view.card.innerHTML = '';
  const box = el('div', 'error');
  box.appendChild(el('div', '', `<b>Something went wrong.</b> ${esc(err.message || err)}`));
  if (retry) { const b = el('button', 'btn', retry.label); b.onclick = retry.fn; box.appendChild(b); }
  view.card.appendChild(box);
  if (err.body) {
    const pre = el('pre', 'raw'); pre.textContent = JSON.stringify(err.body, null, 2); view.card.appendChild(pre);
  }
}

// ---------- audit panel ----------
function absorb(text) {
  for (const id of text.match(RULE_RE) || []) state.ruleCounts.set(id, (state.ruleCounts.get(id) || 0) + 1);
  const s = detectScore(text);
  if (s) state.score = s;
  renderPanel();
}

function detectScore(text) {
  const num = '(\\d{1,3}(?:\\.\\d+)?)\\s*(?:%|/\\s*100)?';
  const pair = new RegExp(`score[^\\n]{0,40}?${num}[^\\n\\d]{0,20}?(?:→|->|➜|to)\\s*${num}`, 'i');
  const single = new RegExp(`score[^\\n\\d]{0,30}?(\\d{1,3}(?:\\.\\d+)?)\\s*(%|/\\s*100)`, 'i');
  const ok = n => n >= 0 && n <= 100;
  let m = text.match(pair);
  if (m && ok(+m[1]) && ok(+m[2])) return { before: +m[1], after: +m[2] };
  m = text.match(single);
  if (m && ok(+m[1])) return { after: +m[1] };
  return null;
}

function renderPanel() {
  const box = $('#scoreBox');
  if (state.score) {
    const { before, after } = state.score;
    const c = after >= 85 ? 'var(--ok)' : after >= 60 ? 'var(--major)' : 'var(--crit)';
    const delta = before != null ? `<div class="score-delta">${before} → <b>${after}</b><br><span class="muted small">${after - before >= 0 ? '+' : ''}${Math.round((after - before) * 10) / 10} pts after rewrite</span></div>`
      : `<div class="score-delta"><b>${after}</b> / 100<br><span class="muted small">Latest reported score</span></div>`;
    box.className = 'score';
    box.innerHTML = `<div class="gauge" style="--v:${after};--c:${c}"><span>${Math.round(after)}</span></div>${delta}`;
  } else {
    box.className = 'muted small';
    box.textContent = 'Appears when Ally reports a score.';
  }

  const rules = $('#rules');
  $('#ruleCount').textContent = state.ruleCounts.size;
  if (!state.ruleCounts.size) {
    rules.className = 'rules muted small';
    rules.textContent = 'Rule IDs Ally cites (e.g. AMZ-TITLE-04) collect here. Click one to ask about it.';
  } else {
    rules.className = 'rules';
    rules.innerHTML = '';
    const groups = {};
    for (const [id, n] of state.ruleCounts) (groups[id.split('-')[1]] ||= []).push([id, n]);
    for (const g of Object.keys(groups).sort()) {
      rules.appendChild(el('div', 'rule-group', esc(g.charAt(0) + g.slice(1).toLowerCase())));
      for (const [id, n] of groups[g].sort()) {
        const row = el('button', 'rule-row', `<span class="rule" data-rule="${id}">${id}</span><span class="n">×${n}</span>`);
        row.dataset.rule = id;
        rules.appendChild(row);
      }
    }
  }

  const acts = $('#panelActions');
  acts.innerHTML = '';
  for (const f of FOLLOWUPS.slice(0, 5)) {
    const b = el('button', 'btn', esc(f.label));
    b.onclick = () => { closeDrawers(); send(f.prompt); };
    acts.appendChild(b);
  }
}

function renderFollowups() {
  const box = $('#followups');
  box.innerHTML = '';
  if (!state.conversationId || state.busy) return;
  for (const f of FOLLOWUPS.filter(f => !state.asked.has(f.prompt)).slice(0, 4)) {
    const c = el('button', 'chip', esc(f.label));
    c.onclick = () => send(f.prompt);
    box.appendChild(c);
  }
}

// ---------- chat flow ----------
function setBusy(b) {
  state.busy = b;
  $('#send').classList.toggle('hidden', b);
  $('#stop').classList.toggle('hidden', !b);
  renderFollowups();
}

async function send(text) {
  text = text.trim();
  if (!text || state.busy) return;
  state.asked.add(text);
  if (state.file) {
    const f = state.file;
    let url;
    try { url = await csvLink(f); } catch (e) { return toast(e.message); }
    text += `\n\nListings CSV (${f.name}, ${f.rows} rows): ${url}`;
    state.file = null;
    state.hasData = true;
    renderAttachment();
  }
  addUser(text);
  const title = stripCsv(text);
  if (!state.conversationId) { state.pendingTitle = title; $('#chatTitle').textContent = title.length > 70 ? title.slice(0, 70) + '…' : title; }
  const view = addBot();
  await run(text, view);
}

async function run(text, view) {
  setBusy(true);
  const ctrl = new AbortController();
  state.abort = ctrl;
  const startedAt = Date.now();
  setThinking(view.card, startedAt);
  try {
    const sent = await api('/api/chat', { method: 'POST', body: JSON.stringify({ message: text, conversation_id: state.conversationId || undefined }), signal: ctrl.signal });
    const cId = findKey(sent.data, ID_KEYS.conv);
    const mId = findKey(sent.data, ID_KEYS.msg);
    if (!cId || !mId) throw Object.assign(new Error('The API did not return a conversation_id and message_id.'), { body: sent });
    const isNew = !state.conversationId;
    state.conversationId = cId;
    remember(cId);
    if (isNew && state.pendingTitle) saveTitle(cId, state.pendingTitle);
    if (isNew) loadHistory();
    await poll(cId, mId, view, text, startedAt, ctrl);
  } catch (err) {
    if (err.name === 'AbortError') view.card.innerHTML = '<span class="muted">Stopped waiting for a reply.</span>';
    else showError(view, err, { label: 'Try again', fn: () => run(text, view) });
  } finally {
    state.abort = null;
    setBusy(false);
  }
}

async function poll(cId, mId, view, userText, startedAt, ctrl) {
  const tick = setInterval(() => setThinking(view.card, startedAt), 1000);
  try {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const r = await api(`/api/poll?cId=${encodeURIComponent(cId)}&mId=${encodeURIComponent(mId)}`, { signal: ctrl.signal });
      if (r.ready) {
        clearInterval(tick);
        const reply = extractReply(r.data, userText);
        fillBot(view, reply || '_The agent returned an empty reply._', r.data);
        scrollDown();
        return;
      }
      await sleep(POLL_INTERVAL_MS, ctrl.signal);
    }
    clearInterval(tick);
    showError(view, new Error('No reply after 3 minutes.'), {
      label: 'Keep waiting',
      fn: async () => {
        setBusy(true);
        const c = new AbortController(); state.abort = c;
        try { await poll(cId, mId, view, userText, Date.now(), c); }
        catch (e) { if (e.name !== 'AbortError') showError(view, e); }
        finally { state.abort = null; setBusy(false); }
      },
    });
  } finally {
    clearInterval(tick);
  }
}

// ---------- history ----------
// Titles for chats started in this browser, used when the API doesn't return one.
function titles() { try { return JSON.parse(localStorage.getItem('ally.titles') || '{}'); } catch { return {}; } }
function savedTitle(id) { return titles()[id] || null; }
function saveTitle(id, t) { try { const all = titles(); all[id] = t.slice(0, 120); localStorage.setItem('ally.titles', JSON.stringify(all)); } catch { /* storage unavailable */ } }
function remember(id) { try { localStorage.setItem('ally.conversation', id); } catch { /* storage unavailable */ } }
function recall() { try { return localStorage.getItem('ally.conversation'); } catch { return null; } }

async function loadHistory() {
  const list = $('#history');
  try {
    const r = await api('/api/conversations?size=30');
    const items = findArray(r.data);
    list.innerHTML = '';
    if (!items.length) { list.innerHTML = '<li class="muted small">No conversations yet.</li>'; return; }
    for (const it of items) {
      const id = findKey(it, ID_KEYS.conv) || (it.id != null ? String(it.id) : null);
      if (!id) continue;
      const title = findKey(it, /^(title|name|summary|first_?message|conversation_?name)$/i) || savedTitle(id) || (extractUserText(it) && stripCsv(extractUserText(it))) || 'Untitled conversation';
      const dateRaw = findKey(it, /^(createdAt|created_at|updatedAt|updated_at|created_on)$/i);
      const date = dateRaw ? new Date(isNaN(dateRaw) ? dateRaw : Number(dateRaw)) : null;
      const li = el('li');
      const b = el('button', id === state.conversationId ? 'active' : '',
        `<span class="h-title">${esc(title)}</span>${date && !isNaN(date) ? `<span class="h-date">${date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>` : ''}`);
      b.onclick = () => { closeDrawers(); openConversation(id, title); };
      li.appendChild(b);
      list.appendChild(li);
    }
  } catch (err) {
    list.innerHTML = `<li class="muted small">Couldn't load history.<br>${esc(err.message)}</li>`;
  }
}

async function openConversation(id, title) {
  if (state.busy) state.abort?.abort();
  reset();
  state.conversationId = id;
  remember(id);
  $('#chatTitle').textContent = title || 'Conversation';
  document.querySelectorAll('.history button').forEach(b => b.classList.toggle('active', b.textContent.startsWith(title)));
  hideWelcome();
  const loading = addBot();
  loading.card.innerHTML = '<div class="thinking"><span class="dots"><i></i><i></i><i></i></span><span>Loading conversation…</span></div>';
  try {
    const r = await api(`/api/conversation?id=${encodeURIComponent(id)}`);
    loading.m.remove();
    let items = findArray(r.data);
    const ts = it => Date.parse(findKey(it, /^(createdAt|created_at)$/i) || '') || 0;
    if (items.length > 1 && ts(items[0]) > ts(items[items.length - 1])) items = [...items].reverse();
    if (!items.length) {
      const v = addBot(); fillBot(v, '_No messages found in this conversation._', r.data);
    }
    for (const it of items) {
      const u = extractUserText(it);
      if (u) { addUser(u); state.asked.add(u); if (hasCsv(u)) state.hasData = true; }
      const reply = extractReply(it, u || '');
      if (reply) fillBot(addBot(), reply, it);
    }
    scrollDown();
  } catch (err) {
    showError(loading, err, { label: 'Try again', fn: () => openConversation(id, title) });
  }
  renderFollowups();
}

function reset() {
  state.conversationId = null;
  state.asked.clear();
  state.ruleCounts.clear();
  state.score = null;
  state.hasData = false;
  state.file = null;
  renderAttachment();
  $('#thread').querySelectorAll('.msg').forEach(n => n.remove());
  renderPanel();
  renderFollowups();
}

function newChat() {
  if (state.busy) state.abort?.abort();
  reset();
  try { localStorage.removeItem('ally.conversation'); } catch { /* ignore */ }
  $('#chatTitle').textContent = 'New audit';
  $('#welcome').classList.remove('hidden');
  document.querySelectorAll('.history button.active').forEach(b => b.classList.remove('active'));
  closeDrawers();
  $('#input').focus();
}

// ---------- wiring ----------
function closeDrawers() { $('#app').classList.remove('sidebar-open', 'panel-open'); }

function init() {
  const starters = $('#starters');
  for (const s of STARTERS) {
    const b = el('button', 'starter', `<span class="tag">${esc(s.tag)}</span><b>${esc(s.title)}</b><span>${esc(s.desc)}</span>`);
    // Audits need data: ask for the CSV first if none is attached yet.
    b.onclick = () => (state.file || state.hasData ? send(s.prompt) : pickFile(s.prompt));
    starters.appendChild(b);
  }

  $('#dropzone').onclick = () => pickFile();
  $('#attach').onclick = () => pickFile();
  $('#fileInput').addEventListener('change', e => attachFile(e.target.files[0]));
  // Drag a CSV anywhere onto the chat.
  const main = $('.main');
  let depth = 0;
  main.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { depth++; main.classList.add('dragging'); $('#composer').classList.add('dragging'); } });
  main.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; main.classList.remove('dragging'); $('#composer').classList.remove('dragging'); } });
  main.addEventListener('dragover', e => e.preventDefault());
  main.addEventListener('drop', e => {
    e.preventDefault(); depth = 0;
    main.classList.remove('dragging'); $('#composer').classList.remove('dragging');
    attachFile(e.dataTransfer.files[0]);
  });

  const input = $('#input');
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px'; };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  $('#composer').addEventListener('submit', e => {
    e.preventDefault();
    const v = input.value;
    if (!v.trim() || state.busy) return;
    input.value = ''; grow();
    send(v);
  });
  $('#stop').onclick = () => state.abort?.abort();
  $('#newChat').onclick = newChat;
  $('#refreshHistory').onclick = loadHistory;
  $('#toggleSidebar').onclick = () => $('#app').classList.toggle('sidebar-open');
  $('#togglePanel').onclick = () => $('#app').classList.toggle('panel-open');
  $('#closePanel').onclick = closeDrawers;
  $('#scrim').onclick = closeDrawers;

  // Rule chips anywhere → ask about that rule.
  document.addEventListener('click', e => {
    const r = e.target.closest('[data-rule]');
    if (!r) return;
    closeDrawers();
    send(`Explain rule ${r.dataset.rule}: what it requires, where this listing breaks it, and the compliant fix.`);
  });

  renderPanel();
  loadHistory();
  const last = recall();
  if (last) openConversation(last, savedTitle(last) || 'Last conversation');
  input.focus();
}

init();

// Listing Compliance Ally — chat client.
// Talks to the local proxy (server.js), which forwards to the SimplAI agent API.

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 180_000;
const RULE_RE = /\bAMZ-[A-Z]+-\d{1,3}\b/g;

// The agent audits every SKU in the CSV, so there is one entry point.
const AUDIT_PROMPT = 'Audit all listings in this CSV against the Amazon content guidelines. For each client SKU, give the compliance score, findings by field with rule ID and severity, a suggested fix for each, and how it compares with its competitor group.';

const FOLLOWUPS = [
  { label: 'Show the compliant rewrite', prompt: 'Show the compliant rewrite of the title, 5 bullets and description for each client SKU, with the rule ID for each change.' },
  { label: 'Benchmark vs competitors', prompt: 'How does each client SKU compare with its competitors? Show each client against its competitor median.' },
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
// SimplAI replies can carry an OpenAI-style message list:
// [{ role: 'assistant', tool_calls }, { role: 'tool', content }, { role: 'assistant', content },
//  { role: 'follow_up_message', content: [..] }]
function findMessages(root) {
  let arr = null;
  bfs(root, (v) => { if (Array.isArray(v) && v.length && v.every(x => x && typeof x === 'object' && 'role' in x)) { arr = v; return true; } });
  return arr;
}

const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => typeof x === 'string' ? x : x?.text || '').join('') : '';

// Groups a message list into turns: { user, reply, steps: [{ name, args, output }], followups }.
function toTurns(messages) {
  const turns = [];
  let cur = null;
  const open = () => (cur ||= { user: null, reply: '', steps: [], followups: [] });
  for (const m of messages) {
    const role = String(m.role).toLowerCase();
    if (role === 'user') { if (cur) turns.push(cur); cur = { user: textOf(m.content), reply: '', steps: [], followups: [] }; continue; }
    const t = open();
    if (role === 'assistant') {
      for (const call of m.tool_calls || []) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* keep empty */ }
        t.steps.push({ id: call.id, name: call.function?.name || 'tool', args, output: null });
      }
      const c = textOf(m.content).trim();
      if (c) t.reply = t.reply ? `${t.reply}\n\n${c}` : c;
    } else if (role === 'tool') {
      const step = t.steps.find(s => s.id === m.tool_call_id) || t.steps[t.steps.length - 1];
      let out = textOf(m.content);
      try { const o = JSON.parse(out); out = typeof o === 'object' && o ? (o.output ?? o.result ?? out) : out; } catch { /* plain text */ }
      if (step) step.output = typeof out === 'string' ? out : JSON.stringify(out);
    } else if (role === 'follow_up_message') {
      t.followups = (Array.isArray(m.content) ? m.content : [m.content]).filter(x => typeof x === 'string' && x.trim());
    }
  }
  if (cur) turns.push(cur);
  return turns;
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
  // Google Sheets links (the rewrite review sheet) become a clear button.
  wrap.querySelectorAll('a[href*="docs.google.com/spreadsheets"]').forEach(a => {
    a.className = 'sheet-link';
    a.innerHTML = '<span class="sheet-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg></span><span>Open review sheet</span><span aria-hidden="true">↗</span>';
    a.title = a.href;
  });
  decorate(wrap);
  structure(wrap, text);
  return wrap;
}

// Makes long replies (full audits) scannable: a scorecard on top, each
// section collapsed to one row with its count, and long tables trimmed.
const LONG_REPLY = 700;
const TABLE_PREVIEW_ROWS = 5;

function structure(wrap, text) {
  wrap.querySelectorAll('table').forEach(trimTable);
  if (text.length < LONG_REPLY) return;

  // Agents often use a bold line instead of a heading: treat it as one.
  for (const p of wrap.querySelectorAll(':scope > p')) {
    const only = p.childNodes.length === 1 && p.firstChild.nodeName === 'STRONG';
    const t = p.textContent.trim().replace(/:$/, '');
    if (only && t.length <= 80) { const h = el('h3', '', esc(t)); h.dataset.pseudo = '1'; p.replaceWith(h); }
  }

  // The scorecard shows the score, so drop a standalone "Compliance score: 48/100" line.
  for (const p of wrap.querySelectorAll(':scope > p')) {
    if (/^\s*(compliance\s+)?score\b[^\n]{0,30}$/i.test(p.textContent) && detectScore(p.textContent)) p.remove();
  }

  // A closing offer ("If you want, I can rewrite…") stays visible below the sections.
  const lastNode = wrap.lastElementChild;
  const closing = lastNode && lastNode.tagName === 'P' ? lastNode : null;
  closing?.remove();

  const heads = [...wrap.querySelectorAll(':scope > h1, :scope > h2, :scope > h3, :scope > h4')];
  if (heads.length >= 2) {
    // Section level = the most common real heading level (bold-line headings
    // count as peers of it); bigger headings stay as titles.
    const counts = {};
    heads.filter(h => !h.dataset.pseudo).forEach(h => { counts[h.tagName] = (counts[h.tagName] || 0) + 1; });
    const level = Object.entries(counts).sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]?.[0] || 'H3';
    const rank = (tag) => Number(tag[1]);
    let current = null, first = true;
    for (const node of [...wrap.childNodes]) {
      const isHead = node.nodeType === 1 && /^H[1-4]$/.test(node.tagName);
      if (isHead && (node.tagName === level || node.dataset.pseudo)) {
        current = el('details', 'section');
        if (first) { current.open = true; first = false; }
        const sum = el('summary', '', `<span class="section-title">${node.innerHTML}</span><span class="section-meta"></span>`);
        current.appendChild(sum);
        current.appendChild(el('div', 'section-body'));
        node.replaceWith(current);
      } else if (isHead && !node.dataset.pseudo && rank(node.tagName) < rank(level)) {
        current = null;
      } else if (current) {
        current.lastChild.appendChild(node);
      }
    }
    wrap.querySelectorAll('details.section').forEach(d => { d.querySelector('.section-meta').innerHTML = sectionMeta(d.lastChild); });
  }

  if (closing) wrap.appendChild(closing);
  const card = scorecard(wrap, text);
  if (card) wrap.prepend(card);
}

function sectionMeta(body) {
  const sev = sevCounts(body);
  const parts = ['critical', 'major', 'minor'].filter(k => sev[k]).map(k => `<span class="sev ${k}">${sev[k]} ${k}</span>`);
  if (parts.length) return parts.join('');
  const rows = body.querySelectorAll('tbody tr').length;
  const items = body.querySelectorAll(':scope > ul > li, :scope > ol > li').length;
  const n = rows || items;
  return n ? `${n} ${rows ? 'rows' : n === 1 ? 'item' : 'items'}` : '';
}

function sevCounts(root) {
  const c = { critical: 0, major: 0, minor: 0 };
  root.querySelectorAll('.sev').forEach(b => { for (const k in c) if (b.classList.contains(k)) c[k]++; });
  return c;
}

function scorecard(wrap, text) {
  const score = detectScore(text);
  const sev = sevCounts(wrap);
  const rules = new Set(text.match(RULE_RE) || []).size;
  if (!score && !sev.critical && !sev.major && !sev.minor) return null;
  const bits = [];
  if (score) {
    const v = score.after, c = v >= 85 ? 'ok' : v >= 60 ? 'major' : 'critical';
    bits.push(`<span class="sc-score ${c}"><b>${Math.round(v)}</b><small>/100</small></span>`);
    if (score.before != null) bits.push(`<span class="sc-item">from ${score.before}</span>`);
  }
  for (const k of ['critical', 'major', 'minor']) if (sev[k]) bits.push(`<span class="sc-item"><i class="dot ${k}"></i>${sev[k]} ${k}</span>`);
  if (rules) bits.push(`<span class="sc-item">${rules} rule${rules === 1 ? '' : 's'}</span>`);
  return el('div', 'scorecard', bits.join(''));
}

function trimTable(table, keep = TABLE_PREVIEW_ROWS) {
  const rows = [...table.querySelectorAll('tbody tr')];
  if (rows.length <= keep + 1) return;
  rows.slice(keep).forEach(r => r.classList.add('extra-row'));
  table.classList.add('trimmed');
  const btn = el('button', 'show-rows', `Show all ${rows.length} rows`);
  btn.type = 'button';
  btn.onclick = () => {
    const open = table.classList.toggle('trimmed');
    btn.textContent = open ? `Show all ${rows.length} rows` : 'Show fewer';
  };
  table.closest('.table-wrap').after(btn);
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
const CSV_LINK_RE = /\s*Listings CSV \(([^)]*)\)[^\n]*?:\s*(https?:\/\/\S+)\s*$/;
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
  const shown = (csv ? text.slice(0, csv.index).trim() : text).split(FORMAT_MARK)[0].split(DETAIL_MARK)[0].trim();
  if (csv) {
    const [name, size] = csv[1].split(',').map(s => s.trim());
    stack.appendChild(fileChip(name || 'listings.csv', size || (block ? `${csvRows(block[2])} rows` : ''), null, link ? link[2] : null));
  }
  // The Start audit instruction is long; show it as a short label.
  if (shown) stack.appendChild(el('div', 'bubble')).textContent = shown === AUDIT_PROMPT ? 'Audit all listings in this CSV' : shown;
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
  $('#dropzoneTitle').textContent = f ? `${f.name} · ${f.rows} listings` : 'Drop your listings CSV here';
  $('#dropzoneSub').textContent = f
    ? 'Ready. Start the audit, or type your own question below.'
    : 'Columns: sku_id, is_client, competitor_group, title, bullet_1–5, description, image_urls';
  if (f) box.appendChild(fileChip(f.name, `${f.rows} listings`, () => { state.file = null; renderAttachment(); }));
}

// Preferred: store the CSV and get a short URL the agent can copy reliably.
// Returns null when storage isn't set up, so the caller falls back to csvLink.
async function uploadLink(f) {
  try {
    const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name, text: f.text }) });
    if (res.status === 501 || res.status === 404) {
      const body = await res.json().catch(() => ({}));
      if (body.origin) state.publicOrigin = body.origin;
      return null;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.url) throw new Error(body.error || `Upload failed (${res.status})`);
    return body.url;
  } catch (err) {
    console.warn('CSV upload failed, using inline link instead:', err);
    return null;
  }
}

// Fallback: packs the CSV into a URL on this site (gzip + base64url) that serves it back
// as text/csv, so the agent's ingest step can fetch it like any hosted file.
const MAX_LINK_CHARS = 12_000;
async function csvLink(f) {
  const gz = await new Response(new Blob([f.text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const bytes = new Uint8Array(gz);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const z = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const name = f.name.replace(/[^\w.-]/g, '_').replace(/(\.csv)?$/i, '.csv');
  const url = `${state.publicOrigin || location.origin}/f/${z}/${name}`;
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
  const label = state.thinkingLabel ? `${state.thinkingLabel}` : secs < 4 ? 'Ally is reading your request…' : secs < 20 ? 'Checking the listing against the rules…' : 'Still working — full audits can take a minute…';
  card.innerHTML = `<div class="thinking"><span class="dots"><i></i><i></i><i></i></span><span>${label}</span><span class="small">${secs}s</span></div>`;
}

function fillBot(view, text, raw, steps = []) {
  view.card.innerHTML = '';
  if (steps.length) view.card.appendChild(renderSteps(steps));
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

// Tool calls the agent made for this reply, e.g. "audit-file → Nothing to Score".
function renderSteps(steps) {
  const box = el('div', 'tool-steps');
  for (const s of steps) {
    const failed = s.output == null || /nothing to score|error|fail|invalid/i.test(s.output);
    const url = s.args?.csv_url;
    const note = typeof url === 'string' && url.startsWith('data:') ? 'csv_url was inline data, not a hosted link' : null;
    const row = el('div', `tool-step ${failed ? 'warn' : 'ok'}`,
      `<span class="ts-icon">${failed ? '!' : '✓'}</span><span class="ts-name">${esc(s.name)}</span>` +
      `<span class="ts-out">${esc(s.output == null ? 'no result' : s.output.length > 120 ? s.output.slice(0, 120) + '…' : s.output)}</span>` +
      (note ? `<span class="ts-note">${esc(note)}</span>` : ''));
    box.appendChild(row);
  }
  return box;
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
  if (s && !state.scoreLocked) state.score = s;
  renderPanel();
}

// Finds the compliance score in a reply. Handles "Compliance score: 41/100",
// "**Score:** 41", "41 out of 100", "0.41", table rows like "| Score | 41 |",
// and before/after forms ("41 → 88", "from 41 to 88", "before 41 … after 88").
function detectScore(text) {
  const plain = text.replace(/\*\*|__|`/g, '');
  const NUM = String.raw`(\d{1,3}(?:\.\d+)?)\s*(?:%|/\s*100|out of 100|pts|points)?`;
  const toPct = (v) => { let n = parseFloat(v); if (n > 0 && n <= 1 && /\./.test(v)) n *= 100; return n >= 0 && n <= 100 ? Math.round(n * 10) / 10 : null; };
  // Lines that state a score, compliance score lines first.
  // A heading like "### Compliance score" may have its number on the next line.
  const all = plain.split('\n');
  const lines = all.flatMap((l, i) => {
    if (!/score/i.test(l)) return [];
    if (/\d/.test(l)) return [l];
    const next = all.slice(i + 1).find(x => x.trim());
    return next ? [`${l} ${next}`] : [];
  });
  lines.sort((a, b) => /compliance/i.test(b) - /compliance/i.test(a));
  for (const line of lines) {
    const after = line.slice(line.search(/score/i));
    const pair = after.match(new RegExp(String.raw`(?:from\s+|before\D{0,15})?${NUM}[^\d\n]{0,25}?(?:→|->|➜|⇒|\bto\b|after\D{0,15})\s*${NUM}`, 'i'));
    if (pair) { const a = toPct(pair[1]), b = toPct(pair[2]); if (a != null && b != null) return { before: a, after: b }; }
    const one = after.match(new RegExp(String.raw`scores?\b[^\d\n]{0,40}?${NUM}`, 'i'));
    if (one && !/^\s*(rules?|findings?|issues?|skus?|listings?|images?)\b/i.test(after.slice(one.index + one[0].length))) {
      const v = toPct(one[1]); if (v != null) return { after: v };
    }
  }
  return null;
}

const RULE_GROUPS = { TITLE: 'Title', BULLET: 'Bullets', BUL: 'Bullets', DESC: 'Description', IMG: 'Images', RESTRICT: 'Restricted claims', KW: 'Keywords' };

function renderPanel() {
  const hasScore = Boolean(state.score), hasRules = state.ruleCounts.size > 0;
  $('#app').classList.toggle('has-summary', hasScore || hasRules);
  $('#panelEmpty').classList.toggle('hidden', hasScore || hasRules);
  $('#scoreSection').classList.toggle('hidden', !hasScore);
  $('#rulesSection').classList.toggle('hidden', !hasRules);

  if (hasScore) {
    const { before, after } = state.score;
    const c = after >= 85 ? 'var(--ok)' : after >= 60 ? 'var(--major)' : 'var(--crit)';
    const label = after >= 85 ? 'Good' : after >= 60 ? 'Needs work' : 'At risk';
    const detail = before != null
      ? `<span class="muted small">Was ${before} · ${after - before >= 0 ? '+' : ''}${Math.round((after - before) * 10) / 10} after rewrite</span>`
      : `<span class="muted small">out of 100</span>`;
    $('#scoreBox').className = 'score';
    $('#scoreBox').innerHTML = `<div class="gauge" style="--v:${after};--c:${c}"><span>${Math.round(after)}</span></div><div class="score-delta"><b style="color:${c}">${label}</b><br>${detail}</div>`;
  }

  $('#ruleCount').textContent = state.ruleCounts.size;
  const rules = $('#rules');
  rules.innerHTML = '';
  const groups = {};
  for (const [id, n] of state.ruleCounts) (groups[id.split('-')[1]] ||= []).push([id, n]);
  for (const g of Object.keys(groups).sort()) {
    const box = el('div', 'rule-group');
    box.appendChild(el('div', 'rule-group-name', esc(RULE_GROUPS[g] || g.charAt(0) + g.slice(1).toLowerCase())));
    const chips = el('div', 'rule-chips');
    for (const [id, n] of groups[g].sort()) {
      const chip = el('button', 'rule', `${id.replace(/^AMZ-/, '')}${n > 1 ? `<span class="n">×${n}</span>` : ''}`);
      chip.dataset.rule = id;
      chip.title = `${id} · cited ${n}× · click to ask about it`;
      chips.appendChild(chip);
    }
    box.appendChild(chips);
    rules.appendChild(box);
  }
}

// Next-step suggestions sit in the thread, right under Ally's latest reply.
function renderFollowups() {
  $('#followups')?.remove();
  if (!state.conversationId || state.busy) return;
  const agent = (state.agentFollowups || []).map(t => ({ label: t, prompt: t, agent: true }));
  const ours = FOLLOWUPS.filter(f => !state.asked.has(f.prompt));
  const images = (state.csv || state.csvUrl) && !state.imagesChecked
    ? [{ label: 'Check images', run: runImageCheck, special: true }] : [];
  const extra = state.extraFollowups || [];
  const items = [...extra.filter(f => !state.asked.has(f.prompt)), ...images, ...agent, ...ours].slice(0, 4);
  if (!items.length) return;
  const box = el('div', 'suggestions');
  box.id = 'followups';
  box.appendChild(el('div', 'suggestions-label', 'Suggested next steps'));
  const row = el('div', 'suggestion-row');
  for (const f of items) {
    const c = el('button', f.special ? 'chip special' : f.agent ? 'chip agent' : 'chip', f.special ? `${IMG_ICON}${esc(f.label)}` : esc(f.label));
    if (f.agent) c.title = 'Suggested by Ally';
    c.onclick = () => (f.run ? f.run() : send(f.prompt));
    row.appendChild(c);
  }
  box.appendChild(row);
  $('#thread').appendChild(box);
  scrollDown();
}

// ---------- chat flow ----------
function setBusy(b) {
  state.busy = b;
  $('#send').classList.toggle('hidden', b);
  $('#stop').classList.toggle('hidden', !b);
  renderFollowups();
}

async function send(text, opts = {}) {
  text = text.trim();
  if (!text || state.busy) return;
  state.asked.add(text);
  if (state.file) {
    const f = state.file;
    let url;
    try { url = await uploadLink(f) || await csvLink(f); } catch (e) { return toast(e.message); }
    text += `\n\nListings CSV (${f.name}, ${f.rows} rows), use as csv_url: ${url}`;
    state.csv = { name: f.name, text: f.text };
    state.file = null;
    state.hasData = true;
    renderAttachment();
  }
  addUser(text);
  const csvName = (text.match(CSV_LINK_RE) || text.match(CSV_BLOCK_RE))?.[1].split(',')[0].trim();
  const title = opts.title || (stripCsv(text) === AUDIT_PROMPT ? `Audit · ${csvName || 'listings'}` : stripCsv(text));
  if (!state.conversationId) { state.pendingTitle = title; $('#chatTitle').textContent = title.length > 70 ? title.slice(0, 70) + '…' : title; }
  const view = addBot();
  state.expectSummary = opts.summary || null;
  state.thinkingLabel = opts.thinking || null;
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
        const msgs = findMessages(r.data);
        const turn = msgs && toTurns(msgs).pop();
        const reply = (turn && turn.reply) || extractReply(r.data, userText);
        const ctx = state.expectSummary; state.expectSummary = null; state.thinkingLabel = null;
        if (!(ctx && reply && renderSummary(view, reply, ctx, r.data))) fillBot(view, reply || '_The agent returned an empty reply._', r.data, turn?.steps || []);
        state.agentFollowups = turn?.followups || [];
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
// Accepts ISO strings, epoch numbers and SimplAI's "DD-MM-YYYY HH:mm:ss".
function parseDate(v) {
  if (v == null || v === '') return null;
  const m = String(v).match(/^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  const d = m ? new Date(+m[3], m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)) : new Date(isNaN(v) ? v : Number(v));
  return isNaN(d) ? null : d;
}

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
      // SimplAI list items look like { cid, message, created_at: "16-10-2026 20:55:20", status }.
      const firstMsg = findKey(it, /^(title|name|summary|first_?message|conversation_?name)$/i) || extractUserText(it)
        || (typeof it.message === 'string' ? it.message : null);
      const first = firstMsg && stripCsv(firstMsg);
      const title = savedTitle(id) || (first === AUDIT_PROMPT ? 'Audit all listings' : first) || 'Untitled conversation';
      const date = parseDate(findKey(it, /^(createdAt|created_at|updatedAt|updated_at|created_on)$/i));
      const li = el('li');
      const b = el('button', id === state.conversationId ? 'active' : '',
        `<span class="h-title">${esc(title)}</span>${date ? `<span class="h-date">${date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>` : ''}`);
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
    const msgs = findMessages(r.data);
    if (msgs) {
      const turns = toTurns(msgs);
      for (const t of turns) {
        if (t.user) { addUser(t.user); state.asked.add(t.user); if (hasCsv(t.user)) { state.hasData = true; rememberCsv(t.user); } }
        if (t.reply || t.steps.length) {
          const v = addBot();
          if (!(t.user?.includes(FORMAT_MARK) && renderSummary(v, t.reply, {}))) fillBot(v, t.reply || '_No reply._', undefined, t.steps);
        }
      }
      state.agentFollowups = turns.at(-1)?.followups || [];
      if (!turns.length) fillBot(addBot(), '_No messages found in this conversation._', r.data);
      scrollDown();
      renderFollowups();
      return;
    }
    let items = findArray(r.data);
    const ts = it => parseDate(findKey(it, /^(createdAt|created_at)$/i))?.getTime() || 0;
    if (items.length > 1 && ts(items[0]) > ts(items[items.length - 1])) items = [...items].reverse();
    if (!items.length) {
      const v = addBot(); fillBot(v, '_No messages found in this conversation._', r.data);
    }
    for (const it of items) {
      const u = extractUserText(it);
      if (u) { addUser(u); state.asked.add(u); if (hasCsv(u)) { state.hasData = true; rememberCsv(u); } }
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
  state.agentFollowups = [];
  state.hasData = false;
  state.file = null;
  state.csv = null;
  state.csvUrl = null;
  state.imagesChecked = false;
  state.extraFollowups = [];
  state.flow = null;
  state.scoreLocked = false;
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
  const startAudit = () => { state.pendingFlow = true; $('#fileInput').value = ''; $('#fileInput').click(); };
  $('#startAudit').onclick = (e) => { e.stopPropagation(); startAudit(); };
  $('#dropzone').onclick = startAudit;
  $('#dropzone').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startAudit(); } };
  $('#attach').onclick = () => pickFile();
  $('#fileInput').addEventListener('change', e => {
    const file = e.target.files[0];
    if (state.pendingFlow) { state.pendingFlow = false; return flowUpload(file); }
    attachFile(file);
  });
  // Drag a CSV anywhere onto the chat.
  const main = $('.main');
  let depth = 0;
  main.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { depth++; main.classList.add('dragging'); $('#composer').classList.add('dragging'); } });
  main.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; main.classList.remove('dragging'); $('#composer').classList.remove('dragging'); } });
  main.addEventListener('dragover', e => e.preventDefault());
  main.addEventListener('drop', e => {
    e.preventDefault(); depth = 0;
    main.classList.remove('dragging'); $('#composer').classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    if (!state.conversationId && !state.busy) return flowUpload(file);
    attachFile(file);
  });

  const input = $('#input');
  if (matchMedia('(max-width: 760px)').matches) input.placeholder = 'Ask Ally…';
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
  // Always start on a fresh audit; past chats are one click away in the sidebar.
  input.focus();
}

init();

// ---------- image checks (run by this app, not the agent) ----------
const IMG_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>';

function rememberCsv(text) {
  const link = text.match(CSV_LINK_RE);
  if (link) { state.csvUrl = link[2]; return; }
  const block = text.match(CSV_BLOCK_RE);
  if (block) state.csv = { name: block[1].split(',')[0].trim(), text: block[2] };
}

// RFC 4180-style CSV parser (quoted fields, embedded commas/newlines, "" escapes).
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.some(v => v.trim()));
  if (!head) return [];
  const keys = head.map(h => h.trim().toLowerCase());
  return body.map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

async function loadCsvText() {
  if (state.csv) return state.csv.text;
  if (!state.csvUrl) return null;
  const res = await fetch(state.csvUrl);
  if (!res.ok) throw new Error(`Couldn't load the CSV (HTTP ${res.status})`);
  const text = await res.text();
  state.csv = { name: decodeURIComponent(state.csvUrl.split('/').pop()), text };
  return text;
}

function skusFromCsv(text) {
  const rows = parseCsv(text);
  const clients = rows.filter(r => /^(true|yes|1)$/i.test(r.is_client || ''));
  return (clients.length ? clients : rows).map(r => ({
    sku_id: r.sku_id || r.sku || r.asin || '',
    title: r.brand ? `${r.brand}${r.sku_id ? ` (${r.sku_id})` : ''}` : r.title?.slice(0, 60) || r.sku_id,
    image_urls: (r.image_urls || '').split(/[|,\s]+/).filter(u => /^https?:\/\//i.test(u)),
  })).filter(s => s.sku_id || s.image_urls.length);
}

async function runImageCheck() {
  if (state.busy) return;
  state.imagesChecked = true;
  addUser('Check images');
  const view = addBot();
  setBusy(true);
  try {
    const skus = skusFromCsv(await loadCsvText() || '');
    if (!skus.length) throw new Error('No SKUs with image_urls found in the CSV.');
    const results = [];
    for (const [i, sku] of skus.entries()) {
      view.card.innerHTML = `<div class="thinking"><span class="dots"><i></i><i></i><i></i></span><span>Checking images for ${esc(sku.title)} (${i + 1} of ${skus.length})…</span></div>`;
      const res = await fetch('/api/images', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sku) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Image check failed (HTTP ${res.status})`);
      results.push(body);
    }
    renderImageReport(view, results);
  } catch (err) {
    showError(view, err, { label: 'Try again', fn: () => { view.m.remove(); state.imagesChecked = false; runImageCheck(); } });
  } finally {
    setBusy(false);
  }
}

function renderImageReport(view, results) {
  const all = results.flatMap(r => [...r.images.flatMap(i => i.checks), ...r.listingChecks]);
  const fails = all.filter(c => c.status === 'fail').length, warns = all.filter(c => c.status === 'warn').length;
  const imgCount = results.reduce((n, r) => n + r.images.length, 0);
  const md = el('div', 'md image-report');
  md.appendChild(el('div', 'scorecard', `<span class="sc-item"><b>Image check</b></span><span class="sc-item">${imgCount} image${imgCount === 1 ? '' : 's'} · ${results.length} SKU${results.length === 1 ? '' : 's'}</span>` +
    (fails ? `<span class="sc-item"><i class="dot critical"></i>${fails} failed</span>` : '') +
    (warns ? `<span class="sc-item"><i class="dot major"></i>${warns} to review</span>` : '') +
    (!fails && !warns ? '<span class="sc-item"><i class="dot ok"></i>All checks passed</span>' : '')));

  results.forEach((r, n) => {
    const d = el('details', 'section'); if (n === 0) d.open = true;
    const rf = [...r.images.flatMap(i => i.checks), ...r.listingChecks];
    const f = rf.filter(c => c.status === 'fail').length, w = rf.filter(c => c.status === 'warn').length;
    d.appendChild(el('summary', '', `<span class="section-title">${esc(r.title || r.sku_id)}</span><span class="section-meta">${f ? `<span class="sev critical">${f} failed</span>` : ''}${w ? `<span class="sev major">${w} to review</span>` : ''}${!f && !w ? '<span class="sev pass">passed</span>' : ''}</span>`));
    const body = el('div', 'section-body');
    for (const c of r.listingChecks) body.appendChild(el('p', 'listing-check', `${statusIcon(c.status)} <b>${esc(c.label)}</b> <span class="muted">· ${esc(c.detail)}</span>`));
    const grid = el('div', 'img-grid');
    for (const img of r.images) grid.appendChild(imageCard(img));
    body.appendChild(grid);
    if (r.aiNote) body.appendChild(el('p', 'muted small', esc(r.aiNote)));
    d.appendChild(body);
    md.appendChild(d);
  });
  md.appendChild(el('p', 'muted small', 'Checked by this app against Amazon’s image requirements: background, fill and resolution are measured; text, props, cropping and sharpness are judged by Claude vision.'));
  view.card.innerHTML = '';
  view.card.appendChild(md);
  scrollDown();
}

const statusIcon = (s) => `<span class="st ${s}">${s === 'pass' ? '✓' : s === 'warn' ? '!' : '✕'}</span>`;

function imageCard(img) {
  const card = el('div', 'img-card');
  const label = img.role === 'main' ? 'Main image' : `Image ${img.index + 1}`;
  const thumb = el('a', 'img-thumb');
  thumb.href = img.url; thumb.target = '_blank'; thumb.rel = 'noopener';
  const pic = new Image(); pic.loading = 'lazy'; pic.alt = label; pic.src = img.thumb || img.url;
  pic.onerror = () => { thumb.classList.add('broken'); pic.remove(); };
  thumb.appendChild(pic);
  card.appendChild(thumb);
  const info = el('div', 'img-info');
  info.appendChild(el('div', 'img-label', `<b>${label}</b>${img.width ? `<span class="muted"> · ${img.width}×${img.height}</span>` : ''}`));
  if (img.error) info.appendChild(el('div', 'img-check', `${statusIcon('fail')}<span>${esc(img.error)}</span>`));
  const issues = img.checks.filter(c => c.status !== 'pass'), passed = img.checks.filter(c => c.status === 'pass');
  for (const c of issues) info.appendChild(el('div', 'img-check', `${statusIcon(c.status)}<span><b>${esc(c.label)}</b>${c.rule ? ` <span class="rule">${esc(c.rule)}</span>` : ''}<br><span class="muted">${esc(c.detail)}</span></span>`));
  if (passed.length) {
    const more = el('details', 'img-passed');
    more.appendChild(el('summary', '', `${passed.length} check${passed.length === 1 ? '' : 's'} passed`));
    for (const c of passed) more.appendChild(el('div', 'img-check', `${statusIcon('pass')}<span>${esc(c.label)} <span class="muted">· ${esc(c.detail)}</span></span>`));
    info.appendChild(more);
  }
  card.appendChild(info);
  return card;
}

// ---------- guided audit flow ----------
// Upload → show what was uploaded → choose which client SKUs → the agent
// audits just those groups → score cards and a summary table. Details only
// come from the agent when you ask for a deep-dive.
const FORMAT_MARK = '\n\nReply in exactly this format';
const FLOW_MAX_BYTES = 5_000_000;
const PREVIEW_ROWS = 6;

const isClientRow = (r, hasCol) => !hasCol || /^(true|yes|y|1)$/i.test(r.is_client || '');
const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

async function flowUpload(file) {
  if (!file) return;
  if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') return toast(`${file.name} isn't a CSV file.`);
  if (file.size > FLOW_MAX_BYTES) return toast(`${file.name} is larger than 5 MB.`);
  const text = (await file.text()).replace(/\r\n?/g, '\n').trim();
  const rows = parseCsv(text);
  if (!rows.length) return toast(`No rows found in ${file.name}.`);
  const header = Object.keys(rows[0]);
  const hasClient = header.includes('is_client');
  const clients = rows.filter(r => isClientRow(r, hasClient)).map(r => ({
    sku_id: r.sku_id || '', brand: r.brand || r.sku_id || 'Listing', group: r.competitor_group || '',
  }));
  const groups = new Set(rows.map(r => r.competitor_group).filter(Boolean));
  state.flow = { name: file.name, text, rows, header, clients, hasClient };
  state.csv = { name: file.name, text };
  state.imagesChecked = false;

  hideWelcome();
  const u = el('div', 'msg user');
  const stack = el('div', 'stack');
  stack.appendChild(fileChip(file.name, `${rows.length} records`));
  u.appendChild(stack);
  $('#thread').appendChild(u);
  $('#chatTitle').textContent = `Audit · ${file.name}`;

  const v = addBot();
  const md = el('div', 'md flow');
  const competitors = rows.length - clients.length;
  md.appendChild(el('div', 'flow-head', `<b>Uploaded ${esc(file.name)}</b><span class="muted">${rows.length} records · ${clients.length} client SKU${clients.length === 1 ? '' : 's'} · ${competitors} competitor${competitors === 1 ? '' : 's'}${groups.size ? ` · ${groups.size} competitor group${groups.size === 1 ? '' : 's'}` : ''}</span>`));
  const missing = ['sku_id', 'is_client', 'competitor_group', 'title'].filter(c => !header.includes(c));
  if (missing.length) md.appendChild(el('p', 'flow-warn', `Missing column${missing.length > 1 ? 's' : ''}: ${esc(missing.join(', '))}`));

  const wrap = el('div', 'table-wrap');
  const table = el('table', '', `<thead><tr><th>SKU</th><th>Brand</th><th>Type</th><th>Competitor group</th></tr></thead><tbody>${rows.map(r =>
    `<tr><td class="mono">${esc(r.sku_id || '')}</td><td>${esc(r.brand || '')}</td><td>${isClientRow(r, hasClient) ? '<span class="sev pass">Client</span>' : '<span class="muted">Competitor</span>'}</td><td class="muted">${esc(r.competitor_group || '–')}</td></tr>`).join('')}</tbody>`);
  wrap.appendChild(table); md.appendChild(wrap);
  trimTable(table, PREVIEW_ROWS);

  if (!clients.length) {
    md.appendChild(el('p', '', 'No client SKUs found (rows with <code>is_client = TRUE</code>). Add one and upload again.'));
  } else {
    md.appendChild(el('p', 'flow-q', '<b>Which listings should I audit?</b>'));
    const choices = el('div', 'flow-choices');
    const options = clients.length <= 6 ? clients.map(c => ({ label: c.brand, sub: c.sku_id, pick: [c] })) : [];
    options.push({ label: clients.length === 2 ? 'Both' : `All ${clients.length}`, sub: clients.length === 2 ? clients.map(c => c.brand).join(' + ') : 'client SKUs', pick: clients, primary: true });
    for (const o of options) {
      const b = el('button', `flow-choice${o.primary ? ' primary' : ''}`, `<b>${esc(o.label)}</b><span>${esc(o.sub)}</span>`);
      b.onclick = () => {
        if (state.busy) return;
        choices.querySelectorAll('button').forEach(x => { x.disabled = true; x.classList.toggle('chosen', x === b); });
        flowAudit(o.pick, o.pick.length === 1 ? o.label : o.pick.length === 2 ? o.pick.map(c => c.brand).join(' and ') : `all ${o.pick.length} client SKUs`);
      };
      choices.appendChild(b);
    }
    md.appendChild(choices);
  }
  v.card.innerHTML = '';
  v.card.appendChild(md);
  scrollDown();
}

async function flowAudit(picked, label) {
  const f = state.flow;
  const ids = new Set(picked.map(c => c.sku_id));
  const groups = new Set(picked.map(c => c.group).filter(Boolean));
  const subset = f.rows.filter(r => ids.has(r.sku_id) || (r.competitor_group && groups.has(r.competitor_group)));
  const csvText = [f.header.map(cell).join(','), ...subset.map(r => f.header.map(h => cell(r[h])).join(','))].join('\n');
  const base = f.name.replace(/\.csv$/i, '');
  const file = { name: `${base}-${label.replace(/[^\w]+/g, '_')}.csv`, text: csvText, rows: subset.length };
  let url;
  try { url = await uploadLink(file) || await csvLink(file); } catch (e) { return toast(e.message); }
  const competitors = subset.length - picked.length;
  const message = `Audit ${label}${FORMAT_MARK} and nothing else:\n\n`
    + 'SKU: <sku_id> · Compliance score: <N>/100\n| SKU | Field | Rule | Severity | Finding | Fix |\n|---|---|---|---|---|---|\n\n'
    + 'One block per client SKU (is_client = TRUE), one table row per finding.'
    + `\n\nListings CSV (${file.name}, ${file.rows} rows), use as csv_url: ${url}`;
  state.hasData = true;
  await send(message, {
    title: `Audit · ${label}`,
    thinking: `Auditing ${subset.length} record${subset.length === 1 ? '' : 's'} (${picked.length} client, ${competitors} competitor${competitors === 1 ? '' : 's'})…`,
    summary: { clients: picked, records: subset.length, competitors },
  });
}

// Reads "SKU: X · Compliance score: N/100" lines and findings tables.
function parseAuditReply(reply, clientIds) {
  const scores = {};
  for (const m of reply.matchAll(/SKU:\s*\**\s*([A-Za-z0-9._-]+)[^\n]*?score[^\d\n]{0,20}(\d{1,3}(?:\.\d+)?)/gi)) scores[m[1]] = Math.min(100, Number(m[2]));
  const findings = [];
  const lines = reply.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) continue;
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.replace(/\*\*|`/g, '').trim());
    const head = cells(lines[i]).map(h => h.toLowerCase());
    const col = (re) => head.findIndex(h => re.test(h));
    const ix = { sku: col(/sku|asin/), field: col(/field|attribute/), rule: col(/rule/), sev: col(/sever|priority/), finding: col(/finding|issue|problem|detail/) };
    for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
      const c = cells(lines[i]);
      const sev = String(ix.sev >= 0 ? c[ix.sev] : '').toLowerCase();
      findings.push({
        sku: ix.sku >= 0 ? c[ix.sku] : '', field: ix.field >= 0 ? c[ix.field] : '',
        rule: (lines[i].match(RULE_RE) || [''])[0], finding: ix.finding >= 0 ? c[ix.finding] : '',
        severity: ['critical', 'major', 'minor'].find(k => sev.includes(k)) || 'minor',
      });
    }
  }
  const ids = clientIds?.length ? clientIds : [...new Set([...Object.keys(scores), ...findings.map(f => f.sku).filter(Boolean)])];
  if (!ids.length) return [];
  return ids.map(id => {
    const mine = findings.filter(f => (f.sku ? f.sku.includes(id) : ids.length === 1));
    let score = scores[id];
    if (score == null && ids.length === 1) score = detectScore(reply)?.after;
    return { sku_id: id, score: score ?? null, findings: mine };
  }).filter(r => r.score != null || r.findings.length);
}

function renderSummary(view, reply, ctx, raw) {
  const clients = ctx.clients || [];
  const results = parseAuditReply(reply, clients.map(c => c.sku_id));
  if (!results.length) return false;
  const brandOf = (id) => clients.find(c => c.sku_id === id)?.brand || state.flow?.clients.find(c => c.sku_id === id)?.brand || '';
  const band = (v) => v == null ? 'none' : v >= 85 ? 'good' : v >= 60 ? 'work' : 'risk';
  const BAND = { good: 'Good', work: 'Needs work', risk: 'At risk', none: 'No score' };

  const md = el('div', 'md flow');
  if (ctx.records) md.appendChild(el('div', 'flow-head', `<b>Audited ${ctx.records} record${ctx.records === 1 ? '' : 's'}</b><span class="muted">${results.length} client SKU${results.length === 1 ? '' : 's'} · ${ctx.competitors} competitor${ctx.competitors === 1 ? '' : 's'}</span>`));

  const cards = el('div', 'score-cards');
  for (const r of results) {
    const b = band(r.score);
    cards.appendChild(el('div', `score-card ${b}`, `<div class="sc-num">${r.score == null ? '–' : Math.round(r.score)}<small>/100</small></div><div><b>${esc(brandOf(r.sku_id) || r.sku_id)}</b><span class="muted mono">${esc(r.sku_id)}</span><span class="sc-band">${BAND[b]}</span></div>`));
  }
  md.appendChild(cards);

  const count = (r, k) => r.findings.filter(f => f.severity === k).length;
  const top = (r) => { const f = r.findings.find(x => x.severity === 'critical') || r.findings[0]; return f ? `${f.rule ? `<span class="rule">${esc(f.rule)}</span> ` : ''}${esc(f.finding || f.field)}` : '<span class="muted">None reported</span>'; };
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'summary-table', `<thead><tr><th>SKU</th><th>Brand</th><th>Score</th><th>Critical</th><th>Major</th><th>Minor</th><th>Top issue</th><th></th></tr></thead><tbody>${results.map(r => `
    <tr><td class="mono">${esc(r.sku_id)}</td><td>${esc(brandOf(r.sku_id))}</td>
    <td><b class="score-${band(r.score)}">${r.score == null ? '–' : Math.round(r.score)}</b></td>
    <td>${count(r, 'critical') ? `<span class="sev critical">${count(r, 'critical')}</span>` : '0'}</td>
    <td>${count(r, 'major') ? `<span class="sev major">${count(r, 'major')}</span>` : '0'}</td>
    <td>${count(r, 'minor') ? `<span class="sev minor">${count(r, 'minor')}</span>` : '0'}</td>
    <td class="top-issue">${top(r)}</td>
    <td><button class="btn deep-dive" data-sku="${esc(r.sku_id)}">Deep-dive</button></td></tr>`).join('')}</tbody>`);
  wrap.appendChild(table); md.appendChild(wrap);
  md.appendChild(el('p', 'muted small', 'Deep-dive on a SKU for every finding by field, the suggested fixes and how it compares with its competitors.'));
  table.querySelectorAll('.deep-dive').forEach(b => {
    b.onclick = () => { const id = b.dataset.sku; send(deepDivePrompt(id, brandOf(id))); };
  });

  view.card.innerHTML = '';
  view.card.appendChild(md);
  const tools = el('div', 'msg-tools');
  const rawBtn = el('button', '', "Agent's reply");
  let pre;
  rawBtn.onclick = () => { if (pre) { pre.remove(); pre = null; return; } pre = el('pre', 'raw'); pre.textContent = reply; view.body.appendChild(pre); };
  tools.appendChild(rawBtn);
  view.body.appendChild(tools);

  // Summary panel: average score and every rule the agent cited.
  absorb(reply);
  const scored = results.filter(r => r.score != null);
  if (scored.length) { state.score = { after: Math.round(scored.reduce((a, r) => a + r.score, 0) / scored.length) }; state.scoreLocked = true; }
  renderPanel();
  state.extraFollowups = results.map(r => ({ label: `Deep-dive ${brandOf(r.sku_id) || r.sku_id}`, prompt: deepDivePrompt(r.sku_id, brandOf(r.sku_id)) }));
  return true;
}

// The instruction after DETAIL_MARK is sent to the agent but not shown in the bubble.
const DETAIL_MARK = '\n\nInclude ';
const deepDivePrompt = (id, brand) => `Deep-dive ${brand ? `${brand} (${id})` : id}${DETAIL_MARK}every finding by field with rule ID, severity and a suggested fix, then compare it with its competitor group.`;


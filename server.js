// Listing Compliance Ally — local dev server.
// Serves the static UI and proxies the SimplAI agent API (same code the Vercel
// functions in api/ use), so the API key never reaches the browser.
// Zero dependencies: Node 18+.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnv(path.join(ROOT, '.env'));

const { runAction, missingConfig } = await import('./lib/simplai.js');
const { decodeCsv, csvHeaders } = await import('./lib/csvlink.js');
const { uploadCsv, readCsv } = await import('./lib/upload.js');
const missing = missingConfig();
if (missing.length) {
  console.error(`Missing config: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
  process.exit(1);
}
const PORT = Number(process.env.PORT || 5173);

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
function serveStatic(req, res, url) {
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (p === '/' || p === '\\') p = '/index.html';
  const pub = path.join(ROOT, 'public');
  const file = path.join(pub, p);
  if (!file.startsWith(pub) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// Same routes as api/*.js on Vercel.
const routes = {
  'POST /api/chat': 'chat',
  'GET /api/poll': 'poll',
  'GET /api/conversations': 'conversations',
  'GET /api/conversation': 'conversation',
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const stored = req.method === 'GET' && url.pathname.match(/^\/c\/([^/]+)\/([^/]+)$/);
  if (stored) {
    const csv = await readCsv(stored[1]).catch(() => null);
    if (csv == null) { res.writeHead(404); return res.end('File not found'); }
    res.writeHead(200, csvHeaders(decodeURIComponent(stored[2]))); return res.end(csv);
  }
  const file = req.method === 'GET' && url.pathname.match(/^\/f\/([^/]+)\/([^/]+)$/);
  if (file) {
    try { const csv = decodeCsv(file[1]); res.writeHead(200, csvHeaders(decodeURIComponent(file[2]))); return res.end(csv); }
    catch { res.writeHead(400); return res.end('Invalid or corrupted file link'); }
  }
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    try { const { status, body } = await uploadCsv({ ...(await readBody(req)), origin: `http://${req.headers.host}` }); return send(res, status, body); }
    catch (err) { return send(res, 400, { error: 'Bad request', detail: err.message }); }
  }
  const action = routes[`${req.method} ${url.pathname}`];
  if (!action) return serveStatic(req, res, url);
  try {
    const params = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
    const { status, body } = await runAction(action, params);
    send(res, status, body);
  } catch (err) {
    send(res, 400, { error: 'Bad request', detail: err.message });
  }
}).listen(PORT, () => {
  console.log(`Listing Compliance Ally UI → http://localhost:${PORT}`);
});

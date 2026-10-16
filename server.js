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
const { uploadCsv, readCsv, storageHealth } = await import('./lib/upload.js');
const { checkSkuImages } = await import('./lib/images.js');
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
  // no-cache: browsers revalidate, so a new deploy shows up on the next load.
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// Same routes as api/*.js on Vercel.
const routes = {
  'POST /api/chat': 'chat',
  'GET /api/poll': 'poll',
  'GET /api/conversations': 'conversations',
  'GET /api/conversation': 'conversation',
};

// Short CSV links. Matches both the public paths and the /api/* paths that
// vercel.json rewrites them to, since Vercel may run this server directly.
function csvLinkParams(url) {
  const p = url.pathname, q = url.searchParams;
  let m;
  if ((m = p.match(/^\/c\/([^/]+)\/([^/]+)$/))) return { kind: 'stored', key: m[1], name: decodeURIComponent(m[2]) };
  if ((m = p.match(/^\/f\/([^/]+)\/([^/]+)$/))) return { kind: 'inline', key: m[1], name: decodeURIComponent(m[2]) };
  if (p === '/api/file') return { kind: 'stored', key: q.get('id'), name: q.get('name') };
  if (p === '/api/csv') return { kind: 'inline', key: q.get('z'), name: q.get('name') };
  return null;
}

async function serveCsvLink(req, res, link) {
  const ua = req.headers['user-agent'] || 'unknown';
  let csv = null;
  try { csv = link.kind === 'stored' ? await readCsv(link.key) : decodeCsv(link.key); }
  catch (err) { console.warn(`csv ${link.kind} link failed: ${err.message}`); }
  if (csv == null) {
    console.warn(`csv file not found: ${link.kind} ${String(link.key).slice(0, 24)} from ${ua}`);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('File not found');
  }
  console.log(`csv file served: ${link.name} (${csv.length} chars) to ${ua}`);
  res.writeHead(200, csvHeaders(link.name));
  res.end(csv);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const link = req.method === 'GET' && csvLinkParams(url);
  if (link) return serveCsvLink(req, res, link);
  if (url.pathname === '/api/health') return send(res, 200, { runtime: 'server.js', storage: await storageHealth() });
  if (req.method === 'POST' && url.pathname === '/api/images') {
    try {
      const body = await readBody(req);
      if (!Array.isArray(body.image_urls)) return send(res, 400, { error: 'image_urls must be an array' });
      return send(res, 200, await checkSkuImages(body));
    } catch (err) { return send(res, 400, { error: 'Bad request', detail: err.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || (host?.startsWith('localhost') ? 'http' : 'https');
    try { const { status, body } = await uploadCsv({ ...(await readBody(req)), origin: `${proto}://${host}` }); return send(res, status, body); }
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

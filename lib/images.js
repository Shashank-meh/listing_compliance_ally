// Image checks against Amazon's product image requirements, run directly by
// this app (not the SimplAI agent). Same split as the text audit:
//   - code measures what has one right answer (white background, how much of
//     the frame the product fills, resolution, file type, image count);
//   - Claude's vision judges what needs looking at (text/logos/badges, props,
//     cropping, sharpness, real photo vs. graphic).
// Needs ANTHROPIC_API_KEY for the vision checks; without it the code checks
// still run and the vision checks are reported as skipped.
import dns from 'node:dns/promises';
import net from 'node:net';

const MODEL = 'claude-opus-5-5';
const MAX_IMAGES = 9;
const MAX_BYTES = 15_000_000;
const FETCH_TIMEOUT_MS = 15_000;

// Map check ids to your rulebook's rule IDs here (e.g. 'MAIN_BACKGROUND':
// 'AMZ-IMG-02') so findings cite amazon_content_guidelines.md. Unmapped
// checks are shown by name only.
export const RULE_IDS = {};

const LABELS = {
  FILE_TYPE: 'JPEG, PNG, GIF or TIFF file',
  RESOLUTION: 'At least 1000 px on the longest side (zoom)',
  MAIN_BACKGROUND: 'Pure white background (RGB 255,255,255)',
  MAIN_FILL: 'Product fills at least 85% of the frame',
  IMAGE_COUNT: '5–7 images per listing',
  MAIN_NO_TEXT: 'No text, logos, badges, watermarks or borders',
  MAIN_NO_PROPS: 'Only the product sold (no props or extras)',
  MAIN_FULL_PRODUCT: 'Whole product in frame, not cropped',
  MAIN_REAL_PHOTO: 'Real photograph, not a drawing, mockup or placeholder',
  SHARP_LIT: 'Sharp, well lit, not pixelated',
  NO_PROMO_CLAIMS: 'No promotional badges or claims ("Best seller", "#1", Amazon logos)',
};

const AI_MAIN = ['MAIN_NO_TEXT', 'MAIN_NO_PROPS', 'MAIN_FULL_PRODUCT', 'MAIN_REAL_PHOTO', 'SHARP_LIT'];
const AI_SECONDARY = ['NO_PROMO_CLAIMS', 'SHARP_LIT'];

const check = (id, status, detail, source) => ({ id, rule: RULE_IDS[id] || null, label: LABELS[id], status, detail, source });

// ---------- fetching (with basic SSRF protection) ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:') && isPrivateIp(v.slice(7));
}

async function assertPublic(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) image URLs are supported');
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => { throw new Error(`Can't resolve ${u.hostname}`); });
  if (addrs.some(a => isPrivateIp(a.address))) throw new Error('Image host is not public');
}

async function fetchImage(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('Not a valid URL'); }
  // Follow redirects by hand so every hop is checked.
  let res;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(u);
    // Image hosts such as Wikimedia require an identifying User-Agent.
    res = await fetch(u, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'manual', headers: { 'User-Agent': 'ListingComplianceAlly/1.0 (Amazon listing image checker)' } });
    if (res.status < 300 || res.status >= 400) break;
    const loc = res.headers.get('location');
    if (!loc) break;
    u = new URL(loc, u);
  }
  if (!res.ok) throw new Error(`Image URL returned HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error('Image is larger than 15 MB');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('Image is larger than 15 MB');
  return buf;
}

// ---------- code checks ----------
async function measure(buf, isMain) {
  const sharp = (await import('sharp')).default;
  const meta = await sharp(buf).metadata();
  const checks = [];
  const okType = ['jpeg', 'png', 'gif', 'tiff'].includes(meta.format);
  checks.push(check('FILE_TYPE', okType ? 'pass' : 'fail', okType ? meta.format.toUpperCase() : `${meta.format || 'unknown'} format`, 'code'));
  const longest = Math.max(meta.width || 0, meta.height || 0);
  checks.push(check('RESOLUTION', longest >= 1000 ? 'pass' : longest >= 500 ? 'warn' : 'fail',
    `${meta.width}×${meta.height}px${longest < 1000 ? ' — zoom needs 1000px+' : ''}`, 'code'));

  if (isMain) {
    // Analyse a small, flattened copy: border whiteness and product bounding box.
    const W = 400;
    const { data, info } = await sharp(buf).flatten({ background: '#ffffff' }).resize(W, W, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = info;
    const px = (x, y) => { const i = (y * w + x) * 3; return [data[i], data[i + 1], data[i + 2]]; };
    const isWhite = ([r, g, b]) => r >= 250 && g >= 250 && b >= 250;
    let edge = 0, edgeWhite = 0;
    for (let x = 0; x < w; x++) for (const y of [0, 1, h - 2, h - 1]) { edge++; if (isWhite(px(x, y))) edgeWhite++; }
    for (let y = 0; y < h; y++) for (const x of [0, 1, w - 2, w - 1]) { edge++; if (isWhite(px(x, y))) edgeWhite++; }
    const whiteShare = edgeWhite / edge;
    checks.push(check('MAIN_BACKGROUND', whiteShare >= 0.97 ? 'pass' : whiteShare >= 0.85 ? 'warn' : 'fail',
      `${Math.round(whiteShare * 100)}% of edge pixels are pure white`, 'code'));

    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y);
      if (r < 245 || g < 245 || b < 245) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (whiteShare < 0.85) checks.push(check('MAIN_FILL', 'warn', "Can't measure until the background is white", 'code'));
    else if (maxX < 0) checks.push(check('MAIN_FILL', 'fail', 'No product found on the background', 'code'));
    else {
      const fill = Math.max((maxX - minX + 1) / w, (maxY - minY + 1) / h);
      checks.push(check('MAIN_FILL', fill >= 0.85 ? 'pass' : fill >= 0.7 ? 'warn' : 'fail', `Product spans ${Math.round(fill * 100)}% of the frame`, 'code'));
    }
  }

  // Copy for the vision model: JPEG, longest side 1568px.
  const forAi = await sharp(buf).flatten({ background: '#ffffff' }).resize(1568, 1568, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  // Small preview for the report, so thumbnails show even if the host blocks hotlinking.
  const thumb = await sharp(buf).flatten({ background: '#ffffff' }).resize(168, 168, { fit: 'inside' }).jpeg({ quality: 70 }).toBuffer();
  return { width: meta.width, height: meta.height, format: meta.format, checks, forAi, thumb: `data:image/jpeg;base64,${thumb.toString('base64')}` };
}

// ---------- vision checks ----------
const AI_SCHEMA = {
  type: 'object',
  properties: {
    images: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          checks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', enum: Object.keys(LABELS) },
                status: { type: 'string', enum: ['pass', 'warn', 'fail'] },
                detail: { type: 'string' },
              },
              required: ['id', 'status', 'detail'],
              additionalProperties: false,
            },
          },
        },
        required: ['index', 'checks'],
        additionalProperties: false,
      },
    },
  },
  required: ['images'],
  additionalProperties: false,
};

async function visionChecks(sku, loaded) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const content = [];
  for (const img of loaded) {
    content.push({ type: 'text', text: `Image ${img.index} (${img.index === 0 ? 'MAIN image' : 'secondary image'}):` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.forAi.toString('base64') } });
  }
  content.push({ type: 'text', text: [
    `These are the Amazon listing images for "${sku.title || sku.sku_id}".`,
    `For the MAIN image (index 0) assess: ${AI_MAIN.map(id => `${id} = ${LABELS[id]}`).join('; ')}.`,
    `For each secondary image assess: ${AI_SECONDARY.map(id => `${id} = ${LABELS[id]}`).join('; ')}. Lifestyle shots, infographics and text callouts are allowed on secondary images.`,
    'Return one entry per image with those checks only. Use "fail" for a clear violation, "warn" when unsure, "pass" otherwise.',
    'In "detail", say what you see in one short sentence (e.g. "Red \'BEST SELLER\' badge top-left"). Do not judge background colour or how much of the frame the product fills; those are measured separately.',
  ].join('\n') });

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: AI_SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  if (response.stop_reason === 'refusal') throw new Error('The vision model declined to review these images');
  const text = response.content.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('The vision model returned no result');
  return JSON.parse(text).images;
}

// ---------- entry point ----------
// sku: { sku_id, title, image_urls: string[] }
export async function checkSkuImages(sku) {
  const urls = (sku.image_urls || []).filter(Boolean).slice(0, MAX_IMAGES);
  const images = await Promise.all(urls.map(async (url, index) => {
    const base = { index, url, role: index === 0 ? 'main' : 'secondary' };
    try {
      const m = await measure(await fetchImage(url), index === 0);
      return { ...base, width: m.width, height: m.height, thumb: m.thumb, checks: m.checks, forAi: m.forAi };
    } catch (err) {
      return { ...base, error: err.message, checks: [] };
    }
  }));

  const loaded = images.filter(i => i.forAi);
  let aiNote = null;
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    aiNote = 'Vision checks skipped: ANTHROPIC_API_KEY is not set on the server.';
  } else if (loaded.length) {
    try {
      const results = await visionChecks(sku, loaded);
      for (const r of results) {
        const img = images[r.index];
        if (!img) continue;
        const allowed = img.role === 'main' ? AI_MAIN : AI_SECONDARY;
        for (const c of r.checks) if (allowed.includes(c.id)) img.checks.push(check(c.id, c.status, c.detail, 'ai'));
      }
    } catch (err) {
      console.error('vision', err);
      aiNote = `Vision checks failed: ${err.message}`;
    }
  }
  for (const img of images) delete img.forAi;

  const count = urls.length;
  const countCheck = check('IMAGE_COUNT', count >= 5 && count <= 9 ? (count <= 7 ? 'pass' : 'warn') : count >= 3 ? 'warn' : 'fail',
    `${count} image${count === 1 ? '' : 's'}${count < 5 ? ` — add ${5 - count} more` : ''}`, 'code');
  return { sku_id: sku.sku_id, title: sku.title || '', images, listingChecks: [countCheck], aiNote };
}

export const imageChecksEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

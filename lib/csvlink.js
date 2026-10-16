// Self-contained CSV links: the file lives in the URL itself as gzip +
// base64url, so the agent can fetch a "hosted" CSV without any storage.
//   /f/<gzip-base64url>/<name>.csv  →  text/csv
import { gunzipSync } from 'node:zlib';

const MAX_BYTES = 1_000_000;

export function decodeCsv(z) {
  if (!z || !/^[A-Za-z0-9_-]+$/.test(z)) throw new Error('Invalid file link');
  const csv = gunzipSync(Buffer.from(z, 'base64url'), { maxOutputLength: MAX_BYTES });
  return csv.toString('utf8');
}

export function csvHeaders(name) {
  const safe = String(name || 'listings.csv').replace(/[^\w.-]/g, '_');
  return {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `inline; filename="${safe}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=31536000, immutable',
  };
}

// Stores an attached CSV in a (private) Vercel Blob store and serves it back
// from this site at a short URL the agent's audit-file tool can fetch:
//   /c/<id>/<name>.csv
// Vercel provides the store credentials (BLOB_READ_WRITE_TOKEN, or
// BLOB_STORE_ID + OIDC) once a Blob store is connected to the project.
import { createHash } from 'node:crypto';

const MAX_BYTES = 1_000_000;
const ACCESS = process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';
const pathFor = (id) => `csv/${id}.csv`;

export const uploadEnabled = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);

export async function uploadCsv({ name, text, origin }) {
  if (!uploadEnabled()) return { status: 501, body: { error: 'File storage is not configured' } };
  if (typeof text !== 'string' || !text.trim()) return { status: 400, body: { error: 'text is required' } };
  if (Buffer.byteLength(text) > MAX_BYTES) return { status: 413, body: { error: 'CSV is larger than 1 MB' } };
  const { put } = await import('@vercel/blob');
  // Same content → same id, so re-sending a file reuses its link.
  const id = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const safe = String(name || 'listings.csv').replace(/[^\w.-]/g, '_').replace(/(\.csv)?$/i, '.csv');
  try {
    await put(pathFor(id), text, { access: ACCESS, contentType: 'text/csv; charset=utf-8', addRandomSuffix: false, allowOverwrite: true });
    return { status: 200, body: { url: `${origin}/c/${id}/${safe}` } };
  } catch (err) {
    console.error('upload', err);
    return { status: 502, body: { error: 'Could not store the CSV', detail: err.message } };
  }
}

// Returns the stored CSV text, or null if the id is unknown.
export async function readCsv(id) {
  if (!/^[a-f0-9]{16}$/.test(id || '')) return null;
  const { get } = await import('@vercel/blob');
  const res = await get(pathFor(id), { access: ACCESS });
  if (!res || res.statusCode !== 200) return null;
  return await new Response(res.stream).text();
}

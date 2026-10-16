// Stores an attached CSV in Vercel Blob and returns a short public URL the
// agent's audit-file tool can fetch. Needs BLOB_READ_WRITE_TOKEN, which Vercel
// adds when a Blob store is connected to the project.
import { createHash } from 'node:crypto';

const MAX_BYTES = 1_000_000;

export const uploadEnabled = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

export async function uploadCsv({ name, text }) {
  if (!uploadEnabled()) return { status: 501, body: { error: 'File storage is not configured' } };
  if (typeof text !== 'string' || !text.trim()) return { status: 400, body: { error: 'text is required' } };
  if (Buffer.byteLength(text) > MAX_BYTES) return { status: 413, body: { error: 'CSV is larger than 1 MB' } };
  const { put } = await import('@vercel/blob');
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 10);
  const safe = String(name || 'listings.csv').replace(/[^\w.-]/g, '_').replace(/(\.csv)?$/i, '.csv');
  try {
    // Same content → same path, so re-sending a file reuses its link.
    const blob = await put(`csv/${hash}-${safe}`, text, {
      access: 'public',
      contentType: 'text/csv; charset=utf-8',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return { status: 200, body: { url: blob.url } };
  } catch (err) {
    console.error('upload', err);
    return { status: 502, body: { error: 'Could not store the CSV', detail: err.message } };
  }
}

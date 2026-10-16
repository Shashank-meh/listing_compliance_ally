import { uploadCsv } from '../lib/upload.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}; }
  catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const { status, body: out } = await uploadCsv({ ...body, origin: `${proto}://${host}` });
  res.status(status).json(out);
}

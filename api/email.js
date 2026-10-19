import { sendApprovalEmail } from '../lib/email.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}; }
  catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  const { status, body: out } = await sendApprovalEmail(body);
  res.status(status).json(out);
}

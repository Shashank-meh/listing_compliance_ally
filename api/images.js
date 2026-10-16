import { checkSkuImages } from '../lib/images.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}; }
  catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  if (!Array.isArray(body.image_urls)) return res.status(400).json({ error: 'image_urls must be an array' });
  res.status(200).json(await checkSkuImages(body));
}

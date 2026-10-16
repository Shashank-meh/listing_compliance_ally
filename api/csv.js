import { decodeCsv, csvHeaders } from '../lib/csvlink.js';

export default function handler(req, res) {
  const ua = req.headers['user-agent'] || 'unknown';
  try {
    const csv = decodeCsv(req.query.z);
    // Logged so Vercel's logs show whether the agent's workflow fetched the file.
    console.log(`csv link served: ${req.query.name} (${csv.length} chars) to ${ua}`);
    for (const [k, v] of Object.entries(csvHeaders(req.query.name))) res.setHeader(k, v);
    res.status(200).send(csv);
  } catch (err) {
    console.warn(`csv link rejected (${String(req.query.z || '').length} chars, ${err.message}) from ${ua}`);
    res.status(400).send('Invalid or corrupted file link');
  }
}

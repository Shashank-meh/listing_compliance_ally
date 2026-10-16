import { decodeCsv, csvHeaders } from '../lib/csvlink.js';

export default function handler(req, res) {
  try {
    const csv = decodeCsv(req.query.z);
    for (const [k, v] of Object.entries(csvHeaders(req.query.name))) res.setHeader(k, v);
    res.status(200).send(csv);
  } catch {
    res.status(400).send('Invalid or corrupted file link');
  }
}

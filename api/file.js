import { readCsv } from '../lib/upload.js';
import { csvHeaders } from '../lib/csvlink.js';

// Serves a stored CSV at /c/<id>/<name>.csv (see vercel.json rewrites).
export default async function handler(req, res) {
  const ua = req.headers['user-agent'] || 'unknown';
  try {
    const csv = await readCsv(req.query.id);
    if (csv == null) {
      console.warn(`csv file not found: ${req.query.id} from ${ua}`);
      return res.status(404).send('File not found');
    }
    console.log(`csv file served: ${req.query.id}/${req.query.name} (${csv.length} chars) to ${ua}`);
    for (const [k, v] of Object.entries(csvHeaders(req.query.name))) res.setHeader(k, v);
    res.status(200).send(csv);
  } catch (err) {
    console.error('file', err);
    res.status(502).send('Could not read the file');
  }
}

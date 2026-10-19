import { readSheetCsv } from '../lib/sheets.js';

export default async function handler(req, res) {
  const { status, body } = await readSheetCsv(req.query.url);
  res.status(status).json(body);
}

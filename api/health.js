import { storageHealth } from '../lib/upload.js';

export default async function handler(req, res) {
  res.status(200).json({ runtime: 'vercel-function', storage: await storageHealth() });
}

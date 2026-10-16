// Wraps a SimplAI action, or any (params) => { status, body } function, as a
// Vercel serverless function.
import { runAction } from './simplai.js';

export function handler(action, method) {
  const run = typeof action === 'function' ? action : (params) => runAction(action, params);
  return async (req, res) => {
    if (req.method !== method) return res.status(405).json({ error: `Use ${method}` });
    let params;
    try {
      params = method === 'POST' ? (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}) : req.query;
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    const { status, body } = await run(params);
    res.status(status).json(body);
  };
}

// Wraps a SimplAI action as a Vercel serverless function.
import { runAction } from './simplai.js';

export function handler(name, method) {
  return async (req, res) => {
    if (req.method !== method) return res.status(405).json({ error: `Use ${method}` });
    const params = method === 'POST' ? (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}) : req.query;
    const { status, body } = await runAction(name, params);
    res.status(status).json(body);
  };
}

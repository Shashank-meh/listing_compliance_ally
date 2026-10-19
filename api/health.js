import { storageHealth } from '../lib/upload.js';
import { imageChecksEnabled } from '../lib/images.js';
import { emailEnabled } from '../lib/email.js';

export default async function handler(req, res) {
  res.status(200).json({ runtime: 'vercel-function', storage: await storageHealth(), imageVision: imageChecksEnabled() ? 'configured' : 'missing ANTHROPIC_API_KEY', email: emailEnabled() ? 'configured' : 'missing RESEND_API_KEY' });
}

import { handler } from '../lib/vercel.js';
import { uploadCsv } from '../lib/upload.js';
export default handler(uploadCsv, 'POST');

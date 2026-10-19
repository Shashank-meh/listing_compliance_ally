import { handler } from '../lib/vercel.js';
import { agentInfo } from '../lib/simplai.js';
export default handler(() => agentInfo(), 'GET');

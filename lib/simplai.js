// SimplAI agent API client. Shared by the local server (server.js) and the
// Vercel functions (api/*.js). Config comes from environment variables.

const cfg = () => ({
  base: (process.env.SIMPLAI_BASE_URL || 'https://edge-service.simplai.ai').replace(/\/$/, ''),
  apiKey: process.env.SIMPLAI_API_KEY,
  tenantId: process.env.SIMPLAI_TENANT_ID,
  userId: process.env.SIMPLAI_USER_ID,
  deviceId: process.env.SIMPLAI_DEVICE_ID || 'simplai',
  agentId: process.env.SIMPLAI_AGENT_ID,
});

export function missingConfig() {
  const c = cfg();
  return ['apiKey', 'tenantId', 'userId', 'agentId'].filter(k => !c[k]);
}

async function upstream(method, pathAndQuery, body) {
  const c = cfg();
  const res = await fetch(c.base + pathAndQuery, {
    method,
    headers: {
      'PIM-SID': c.apiKey,
      'X-TENANT-ID': c.tenantId,
      'X-USER-ID': c.userId,
      'X-DEVICE-ID': c.deviceId,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(55_000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, headers: res.headers, data };
}

// Each action takes plain params and returns { status, body }.
export const actions = {
  // Send or continue a chat.
  async chat({ message, conversation_id }) {
    if (!message || typeof message !== 'string') return { status: 400, body: { error: 'message is required' } };
    const r = await upstream('POST', '/interact/api/ve1/intract/agent/conversation', {
      agent_id: cfg().agentId,
      language_code: 'EN',
      source: 'APP',
      action: 'START_SCREEN',
      ...(conversation_id ? { conversation_id } : {}),
      query: { message, message_type: 'string', message_category: 'string' },
    });
    return { status: r.status, body: { data: r.data } };
  },

  // Poll once for a reply. Exposes the message_status response header as JSON.
  async poll({ cId, mId }) {
    if (!cId || !mId) return { status: 400, body: { error: 'cId and mId are required' } };
    const r = await upstream('GET', `/interact/api/v1/intract/conversation/fetchDetails?${new URLSearchParams({ cId, mId })}`);
    const status = r.headers.get('message_status') ?? r.headers.get('message-status');
    return { status: r.status, body: { message_status: status, ready: String(status) === '2', data: r.data } };
  },

  // List past conversations.
  async conversations({ size, page }) {
    const qs = new URLSearchParams({ userId: cfg().userId, size: size || '20', sort: 'createdAt,desc', page: page || '0' });
    const r = await upstream('GET', `/interact/api/ve1/intract/conversation?${qs}`);
    return { status: r.status, body: { data: r.data } };
  },

  // Full conversation.
  async conversation({ id }) {
    if (!id) return { status: 400, body: { error: 'id is required' } };
    const r = await upstream('GET', `/interact/api/ve1/intract/conversation/${encodeURIComponent(id)}?userId=${encodeURIComponent(cfg().userId)}`);
    return { status: r.status, body: { data: r.data } };
  },
};

// Runs an action and turns network failures into a 502 the UI can show.
export async function runAction(name, params) {
  const missing = missingConfig();
  if (missing.length) return { status: 500, body: { error: `Server is missing config: ${missing.join(', ')}` } };
  try {
    return await actions[name](params);
  } catch (err) {
    console.error(name, err);
    return { status: 502, body: { error: 'Could not reach the SimplAI API', detail: String(err.cause?.message || err.message) } };
  }
}

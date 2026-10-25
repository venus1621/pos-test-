// Thin client for the CLICKADDIS e-invoicing API. The API key never leaves the server.
const BASE = process.env.EIMS_BASE_URL || 'https://eims.clickaddis.cloud/api/v1';

async function eims(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${process.env.EIMS_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45000), // finalize "now" can wait ~30s for the Ministry
  });
  if (res.status === 204) return { status: 204, body: null };
  const isJson = (res.headers.get('content-type') || '').includes('json');
  return { status: res.status, body: isJson ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

// Turns an error envelope into one readable line (and keeps requestId for support).
function errText(r) {
  const e = r.body && r.body.error;
  if (!e) return `HTTP ${r.status}`;
  const d = Array.isArray(e.details) ? e.details.map(x => `${x.field}: ${x.message}`) : (e.details && e.details.problems) || [];
  return `${e.code}: ${e.message}${d.length ? ' - ' + d.join('; ') : ''} (requestId ${e.requestId})`;
}

let cachedSource = process.env.EIMS_SOURCE_SYSTEM_ID || null;
async function sourceSystemId() {
  if (cachedSource) return cachedSource;
  const r = await eims('GET', '/source-systems');
  const s = r.body && r.body.data && r.body.data.find(x => x.active);
  if (!s) throw new Error('No active source system. ' + errText(r));
  return (cachedSource = s.id);
}

module.exports = { eims, errText, sourceSystemId };

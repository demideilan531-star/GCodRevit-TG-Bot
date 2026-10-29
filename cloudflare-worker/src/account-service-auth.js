const PREFIX = '/internal/account-context/';
const ENDPOINTS = new Set(['claim', 'state', 'batch', 'finish', 'heartbeat']);
const RUN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();

export function isAccountServiceRequest(request) {
  return (request.headers.get('Authorization') || '').startsWith('Context-HMAC ');
}

export async function verifyAccountService(request, env, bodyHash, now = Date.now()) {
  if (env.TELEGRAM_ACCOUNT_SERVICE_ENABLED !== 'true') return null;
  const secret = env.TELEGRAM_ACCOUNT_SERVICE_SECRET;
  const service = env.TELEGRAM_ACCOUNT_SERVICE_ID;
  if (!/^[0-9a-f]{64}$/.test(secret || '') || !/^[a-z0-9-]{3,48}$/.test(service || '')) return null;
  const url = new URL(request.url);
  const run = request.headers.get('X-Context-Run') || '';
  const timestamp = request.headers.get('X-Context-Timestamp') || '';
  const signature = (request.headers.get('Authorization') || '').slice('Context-HMAC '.length);
  if (request.method !== 'POST' || url.search || !url.pathname.startsWith(PREFIX) ||
      !ENDPOINTS.has(url.pathname.slice(PREFIX.length)) || !RUN.test(run) ||
      request.headers.get('X-Context-Service') !== service || !/^\d{10}$/.test(timestamp) ||
      Math.abs(now / 1000 - Number(timestamp)) > 60 || !/^[0-9a-f]{64}$/.test(signature) ||
      !/^[0-9a-f]{64}$/.test(bodyHash)) return null;
  try {
    const bytes = value => Uint8Array.from(value.match(/../g), pair => parseInt(pair, 16));
    const key = await crypto.subtle.importKey('raw', bytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    // The exact operation, body and lease run are bound to the signature. A
    // replay can only repeat that operation; lease CAS/batch receipts fence it.
    const canonical = ['context-service:v1', 'POST', url.pathname, service, run, timestamp, bodyHash].join('\n');
    const valid = await crypto.subtle.verify('HMAC', key, bytes(signature), encoder.encode(canonical));
    return valid ? { run: `service:${service}:${run}` } : null;
  } catch { return null; }
}

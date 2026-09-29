const crypto = require('crypto');

/**
 * Short-lived SSO ticket for hosted runtimes that keep one account per buyer
 * (Open WebUI, Paperclip). The runtime verifies the HMAC with the SAME secret:
 *   `${PREFIX}_SSO_SECRET`, else `AIMARKETS_RUNTIME_SSO_SECRET`.
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256("aimr.v1.<runtime>." + payload)).
 */
const USER_ID_RE = /^[a-f0-9]{24}$/i;
const RUNTIME_RE = /^[a-z][a-z0-9-]{1,31}$/;
const DEFAULT_TTL_MS = 2 * 60 * 1000;

function ssoSecret(envPrefix) {
  return String(
    process.env[`${envPrefix}_SSO_SECRET`] || process.env.AIMARKETS_RUNTIME_SSO_SECRET || ''
  ).trim();
}

function sign(runtime, payloadB64, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`aimr.v1.${runtime}.${payloadB64}`, 'utf8')
    .digest('base64url');
}

function cleanName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, 80);
}

/**
 * @param {{ runtime: string, envPrefix: string, user: { _id?: any, id?: any, name?: string, email?: string }, ttlMs?: number, now?: number }} p
 * @returns {string} ticket, or '' when the user id or secret is missing
 */
function issueRuntimeTicket({ runtime, envPrefix, user, ttlMs = DEFAULT_TTL_MS, now = Date.now() }) {
  const uid = String(user?._id || user?.id || '').trim().toLowerCase();
  const secret = ssoSecret(envPrefix);
  if (!RUNTIME_RE.test(runtime) || !USER_ID_RE.test(uid) || !secret) return '';
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      rt: runtime,
      uid,
      name: cleanName(user?.name) || cleanName(String(user?.email || '').split('@')[0]),
      email: String(user?.email || '').trim().toLowerCase().slice(0, 254),
      exp: now + ttlMs,
      jti: crypto.randomBytes(9).toString('base64url'),
    }),
    'utf8'
  ).toString('base64url');
  return `${payload}.${sign(runtime, payload, secret)}`;
}

/** Mirror of the runtime-side check; used by tests and for debugging tickets. */
function verifyRuntimeTicket({ runtime, envPrefix, ticket, now = Date.now() }) {
  const secret = ssoSecret(envPrefix);
  const raw = String(ticket || '').trim();
  if (!secret || !raw) return null;
  const [payload, sig, extra] = raw.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(runtime, payload, secret));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data?.v !== 1 || data?.rt !== runtime) return null;
    if (!USER_ID_RE.test(String(data?.uid || ''))) return null;
    if (!Number.isFinite(data?.exp) || data.exp < now) return null;
    return data;
  } catch {
    return null;
  }
}

module.exports = { issueRuntimeTicket, verifyRuntimeTicket, ssoSecret, DEFAULT_TTL_MS };

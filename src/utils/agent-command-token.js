const crypto = require('crypto');

/**
 * Per-user, per-agent command tokens for the copyable commands on the setup page.
 *
 * A token is bound to ONE buyer (uid), ONE runtime (openclaw, hermes, ...) and ONE
 * action (e.g. `pairing.approve`), and expires after a few minutes. The API only
 * accepts it on the matching route and always acts on the buyer's own instance;
 * there is no way to name another user, another agent or a global target with it.
 *
 * Format: `amc1.<base64url(JSON)>.<base64url(HMAC-SHA256("amc.v1." + payload))>`
 */
const USER_ID_RE = /^[a-f0-9]{24}$/;
const RUNTIMES = new Set(['openclaw', 'hermes', 'nanoclaw', 'spacebot', 'paperclip', 'openwebui']);
const ACTIONS = new Set(['pairing.approve', 'launch']);
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 30 * 60 * 1000;

function commandTokenSecret() {
  return String(
    process.env.AGENT_COMMAND_TOKEN_SECRET ||
      process.env.AIMARKETS_SERVICE_SECRET ||
      process.env.JWT_SECRET ||
      ''
  ).trim();
}

function sign(payload, secret) {
  // Domain-separated so the secret can be shared with other HMAC uses safely.
  return crypto.createHmac('sha256', secret).update(`amc.v1.${payload}`, 'utf8').digest('base64url');
}

function issueCommandToken({ userId, runtime, action, ttlMs = DEFAULT_TTL_MS, now = Date.now() }) {
  const uid = String(userId || '').trim().toLowerCase();
  const secret = commandTokenSecret();
  if (!USER_ID_RE.test(uid) || !RUNTIMES.has(runtime) || !ACTIONS.has(action) || !secret) return '';
  const ttl = Math.max(30 * 1000, Math.min(MAX_TTL_MS, Number(ttlMs) || DEFAULT_TTL_MS));
  const payload = Buffer.from(
    JSON.stringify({ v: 1, uid, rt: runtime, act: action, exp: now + ttl, jti: crypto.randomBytes(9).toString('base64url') }),
    'utf8'
  ).toString('base64url');
  return `amc1.${payload}.${sign(payload, secret)}`;
}

/**
 * @returns {{ uid: string, rt: string, act: string, exp: number, jti: string } | null}
 * Null unless the token is authentic, unexpired AND matches the expected runtime/action.
 */
function verifyCommandToken(token, { runtime, action, now = Date.now() } = {}) {
  const secret = commandTokenSecret();
  const raw = String(token || '').trim();
  if (!secret || !raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== 'amc1') return null;
  const [, payload, sig] = parts;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payload, secret));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (data?.v !== 1 || !USER_ID_RE.test(String(data.uid || ''))) return null;
  if (!Number.isFinite(data.exp) || data.exp < now || data.exp > now + MAX_TTL_MS + 60 * 1000) return null;
  if (runtime && data.rt !== runtime) return null;
  if (action && data.act !== action) return null;
  return data;
}

/** Reads `Authorization: AgentCommand <token>` (or Bearer amc1.*). */
function readCommandToken(req) {
  const header = String(req.headers?.authorization || '').trim();
  const m = header.match(/^(?:AgentCommand|Bearer)\s+(amc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
  return m ? m[1] : '';
}

module.exports = {
  issueCommandToken,
  verifyCommandToken,
  readCommandToken,
  commandTokenSecret,
  RUNTIMES,
  DEFAULT_TTL_MS,
};
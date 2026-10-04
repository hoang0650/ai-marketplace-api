const crypto = require('crypto');

/**
 * Signed AI Markets OpenClaw ticket: proves the Control UI tab belongs to one buyer.
 * The gateway verifies the same HMAC (openclaw src/gateway/aimarkets-ticket.ts),
 * so the secret chain below must stay identical on both sides.
 */
const USER_ID_RE = /^[a-f0-9]{24}$/i;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function ticketSecret() {
  return String(
    process.env.OPENCLAW_MARKET_TICKET_SECRET ||
      process.env.AIMARKETS_SERVICE_SECRET ||
      process.env.NEST_SERVICE_AUTH_SECRET ||
      process.env.PYTHON_AI_SHARED_SECRET ||
      ''
  ).trim();
}

function sign(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(`aimt.v1.${payloadB64}`, 'utf8').digest('base64url');
}

function issueMarketTicket(userId, ttlMs = DEFAULT_TTL_MS) {
  const uid = String(userId || '').trim().toLowerCase();
  const secret = ticketSecret();
  if (!USER_ID_RE.test(uid) || !secret) return '';
  const payload = Buffer.from(
    JSON.stringify({ uid, exp: Date.now() + ttlMs }),
    'utf8'
  ).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** @returns {string|null} verified userId */
function verifyMarketTicket(ticket) {
  const secret = ticketSecret();
  const raw = String(ticket || '').trim();
  if (!secret || !raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const uid = String(data?.uid || '').toLowerCase();
    if (!USER_ID_RE.test(uid)) return null;
    if (!Number.isFinite(data?.exp) || data.exp < Date.now()) return null;
    return uid;
  } catch {
    return null;
  }
}

/**
 * Gateway token for AI Markets Control UI connections. The gateway accepts it
 * on AI Markets hosts only (openclaw src/gateway/aimarkets-ticket.ts), so the
 * token PHHotel uses is never handed to buyers. Empty unless both secrets are set.
 */
function aimarketsGatewayToken() {
  const serviceSecret = String(process.env.AIMARKETS_SERVICE_SECRET || '').trim();
  const ticketSecretValue = String(process.env.OPENCLAW_MARKET_TICKET_SECRET || '').trim();
  if (!serviceSecret || !ticketSecretValue) return '';
  return crypto
    .createHmac('sha256', ticketSecretValue)
    .update(`aimarkets-openclaw-gateway:v1:${serviceSecret}`, 'utf8')
    .digest('hex')
    .slice(0, 48);
}

module.exports = { issueMarketTicket, verifyMarketTicket, ticketSecret, aimarketsGatewayToken };

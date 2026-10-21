const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { sendResendEmail, isEmailReady } = require('../utils/mailer');
const { renderEmail, siteUrl } = require('./templates');

/**
 * Transactional email dispatcher (Resend). Fire-and-forget: never throws, never blocks
 * the request. Off unless RESEND_API_KEY is set (and SKIP_EMAIL is not).
 */

/** Minimum gap between two emails of the same kind to the same address. */
const RATE_WINDOW_MS = {
  loginNotice: 10 * 60 * 1000,
  passwordReset: 2 * 60 * 1000,
  welcome: 60 * 60 * 1000,
  passwordChanged: 60 * 1000,
  notification: 0,
};
const MAX_PER_HOUR = 20;
const recent = new Map(); // `${to}|${kind}` -> ts
const hourly = new Map(); // to -> [ts...]

function rateLimited(to, kind, now = Date.now()) {
  const gap = RATE_WINDOW_MS[kind] ?? 0;
  const key = `${to}|${kind}`;
  if (gap && recent.has(key) && now - recent.get(key) < gap) return true;
  const list = (hourly.get(to) || []).filter((t) => now - t < 3600 * 1000);
  if (list.length >= MAX_PER_HOUR) return true;
  list.push(now);
  hourly.set(to, list);
  recent.set(key, now);
  if (recent.size > 20000) recent.clear();
  if (hourly.size > 20000) hourly.clear();
  return false;
}

function userLang(user) {
  return user?.profile?.notifyLang || 'vi';
}

/** Non-critical kinds the user can turn off (critical: reset, password changed, receipts, refunds, complaints). */
const OPTIONAL_KINDS = { loginNotice: 'emailLoginAlerts' };

function optedOut(user, kind) {
  const pref = OPTIONAL_KINDS[kind];
  return !!(pref && user?.preferences && user.preferences[pref] === false);
}

function unsubscribeToken(userId, kind) {
  return jwt.sign({ typ: 'email-unsub', sub: String(userId), kind }, config.jwtSecret, { expiresIn: '180d' });
}

function unsubscribeUrl(userId, kind) {
  const api = String(config.apiPublicUrl || (config.isProduction ? 'https://api.aimarkets.vn' : '')).replace(/\/+$/, '');
  const token = unsubscribeToken(userId, kind);
  return api
    ? `${api}/v1/auth/email/unsubscribe?token=${encodeURIComponent(token)}`
    : siteUrl(`/settings?unsubscribe=${encodeURIComponent(token)}`);
}

function verifyUnsubscribeToken(token) {
  try {
    const c = jwt.verify(String(token || ''), config.jwtSecret);
    if (c.typ !== 'email-unsub' || !OPTIONAL_KINDS[c.kind]) return null;
    return { userId: c.sub, kind: c.kind, pref: OPTIONAL_KINDS[c.kind] };
  } catch {
    return null;
  }
}

/** Test hook: replace the transport (never hits Resend). */
let transport = sendResendEmail;
function setTransport(fn) {
  transport = fn || sendResendEmail;
}

/** Seed/test accounts (example.* and the seeded creators.dev studios) never receive real mail. */
const TEST_DOMAINS = String(process.env.EMAIL_SUPPRESS_DOMAINS || 'example.com,example.org,example.net,creators.dev')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);
function isTestRecipient(to) {
  const domain = String(to).split('@').pop();
  return TEST_DOMAINS.includes(domain) || /\.(test|invalid|example|localhost)$/.test(domain);
}

async function deliver(user, kind, data = {}) {
  const to = String(data.to || user?.email || '').trim().toLowerCase();
  if (!to || !to.includes('@')) return { skipped: true, reason: 'INVALID_TO' };
  if (transport === sendResendEmail && !isEmailReady()) return { skipped: true, reason: 'EMAIL_OFF' };
  if (transport === sendResendEmail && isTestRecipient(to)) {
    console.log(`[mail] suppressed test recipient (${kind}) ${to.replace(/^(.).*@/, '$1***@')}`);
    return { skipped: true, reason: 'TEST_RECIPIENT' };
  }
  if (optedOut(user, kind)) return { skipped: true, reason: 'OPTED_OUT' };
  if (rateLimited(to, kind)) return { skipped: true, reason: 'RATE_LIMITED' };
  const extra = OPTIONAL_KINDS[kind] && user?._id ? { unsubscribeUrl: unsubscribeUrl(user._id, kind) } : {};
  const mail = renderEmail(kind, { l: userLang(user), name: user?.name, ...data, ...extra });
  const res = await transport({ to, subject: mail.subject, html: mail.html, text: mail.text, tags: [{ name: 'category', value: kind }] });
  if (res && res.ok === false) console.error(`[mail] ${kind} failed: ${res.error}`);
  return res;
}

/** Fire-and-forget. Returns immediately; errors are logged, never thrown. */
function sendTransactional(user, kind, data) {
  setImmediate(() => {
    deliver(user, kind, data).catch((err) => console.error(`[mail] ${kind} threw: ${err?.message || err}`));
  });
}

module.exports = {
  isTestRecipient,
  sendTransactional,
  deliver,
  setTransport,
  rateLimited,
  verifyUnsubscribeToken,
  unsubscribeToken,
  OPTIONAL_KINDS,
  _resetRateLimit: () => {
    recent.clear();
    hourly.clear();
  },
};

const crypto = require('crypto');
const { verifyRuntimeTicket, ssoSecret } = require('../utils/runtime-sso-ticket');
const { getByokProvider } = require('../utils/byok-providers');

const RuntimeByokClaim = require('../models/RuntimeByokClaim');
const User = require('../models/User');
const { effectiveStatus } = require('../utils/moderation');
const MAX_TICKET_LEN = 4096;

function secretMatches(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** One buyer key row → one OpenAI-compatible connection, or null when the provider has no such endpoint. */
function toOpenAICompatibleConnection({ provider, apiKey, baseUrl, model }) {
  const spec = getByokProvider(provider);
  if (!spec || !apiKey) return null;
  const url = spec.custom ? String(baseUrl || '') : spec.openaiBaseUrl;
  if (!url || !/^https:\/\//i.test(url)) return null;
  return {
    provider: spec.id,
    label: spec.label,
    baseUrl: url.replace(/\/+$/, ''),
    apiKey,
    modelIds: spec.custom && model ? [model] : [],
  };
}

/**
 * Server-to-server hand-off of ONE buyer's BYOK keys to a hosted runtime.
 * The runtime proves itself with `X-Runtime-Secret` (= its SSO secret) and the buyer with the
 * SSO ticket it just received, so it can only ever read the keys of the buyer who is launching.
 * Each ticket can be claimed once.
 *
 * @param {{ runtime: string, envPrefix: string, loadKeys: (uid: string) => Promise<Array<{provider: string, apiKey: string, baseUrl?: string, model?: string}>> }} opts
 */
function createByokClaimHandler({ runtime, envPrefix, loadKeys }) {
  async function consume(jti, expMs) {
    const id = crypto.createHash('sha256').update(runtime + ':' + jti).digest('hex');
    try { await RuntimeByokClaim.create({ _id: id, expiresAt: new Date(expMs + 60000) }); return true; }
    catch (err) { if (err.code === 11000) return false; throw err; }
  }

  return async function byokClaim(req, res, next) {
    try {
      res.set('Cache-Control', 'no-store');
      const secret = ssoSecret(envPrefix);
      if (!secret) {
        return res.status(503).json({ success: false, message: `${envPrefix}_SSO_SECRET is not configured.` });
      }
      if (!secretMatches(req.headers['x-runtime-secret'], secret)) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }
      const ticket = String(req.body?.ticket || '').trim();
      const data = ticket.length <= MAX_TICKET_LEN ? verifyRuntimeTicket({ runtime, envPrefix, ticket }) : null;
      if (!data) {
        return res.status(401).json({ success: false, code: 'TICKET_INVALID', message: 'Invalid or expired ticket.' });
      }
      if (!data.jti || !await consume(String(data.jti), Number(data.exp))) {
        return res.status(409).json({ success: false, code: 'TICKET_CLAIMED', message: 'Ticket already claimed.' });
      }

      const user = await User.findById(data.uid).select('accountStatus suspendedUntil').lean();
      if (!user || effectiveStatus(user) !== 'active') return res.status(403).json({ success: false, message: 'Account unavailable' });
      const rows = await loadKeys(data.uid);
      const connections = rows.map(toOpenAICompatibleConnection).filter(Boolean);
      return res.json({ success: true, userId: data.uid, connections });
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { createByokClaimHandler, toOpenAICompatibleConnection };

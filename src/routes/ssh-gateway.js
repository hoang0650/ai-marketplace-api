const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const SshSession = require('../models/SshSession');
const { verifyGatewayLogin, listActiveSandboxSessions } = require('../services/ssh-sandbox');

/**
 * Internal endpoints for the SSH sandbox gateway only. Guarded by a dedicated
 * secret (SSH_GATEWAY_SHARED_SECRET), not the broader service secret, so a leak
 * of one does not grant the other.
 */
function gatewaySecretOk(req) {
  const expected = String(process.env.SSH_GATEWAY_SHARED_SECRET || '').trim();
  if (expected.length < 32) return false;
  const got = String(req.headers['x-ssh-gateway-secret'] || '').trim();
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireGateway(req, res, next) {
  if (!gatewaySecretOk(req)) return res.status(401).json({ ok: false });
  res.set('Cache-Control', 'no-store');
  return next();
}

function createRouter({ Model = SshSession } = {}) {
  const router = express.Router();
  router.use(requireGateway);

  const authLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 20,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => `u:${String(req.body?.username || '').slice(0, 64)}`,
    message: { ok: false, code: 'rate_limited' },
  });

  router.post('/auth', authLimiter, async (req, res, next) => {
    try {
      const username = String(req.body?.username || '').slice(0, 64);
      const password = String(req.body?.password || '').slice(0, 256);
      const result = await verifyGatewayLogin({ SshSession: Model, username, password });
      if (!result) return res.status(401).json({ ok: false });
      return res.json({ ok: true, ...result });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/active', async (_req, res, next) => {
    try {
      const sessions = await listActiveSandboxSessions({ SshSession: Model });
      return res.json({ ok: true, sessions });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
module.exports.gatewaySecretOk = gatewaySecretOk;

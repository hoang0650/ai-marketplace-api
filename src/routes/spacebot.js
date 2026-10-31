const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { authenticate } = require('../middleware/auth');
const SshSession = require('../models/SshSession');
const WalletTx = require('../models/WalletTx');
const { getAvailableBalance } = require('../utils/wallet');
const {
  assertActiveSubscription,
  getSubscriptionStatus,
  hasActiveSubscriptionByUserId,
} = require('../finance/agent-subscription');
const { generateSshKeyPair } = require('../utils/ssh-keys');
const { dashboardTokenForUser } = require('../utils/spacebot-token');
const { passwordStorage, publicSshSession, legacySecretUnset } = require('../services/ssh-session-public');
const { spacebotUnlistedError } = require('../services/spacebot-listing');
const {
  AIMARKETS_PROVIDER_MARKUP,
  computeOpenClawSellCost,
  isPhhotelModelId,
} = require('../utils/openclaw-pricing');

const router = express.Router();
const SSH_TTL_MS = 60 * 60 * 1000;
const USER_ID_RE = /^[a-f0-9]{24}$/i;
const AIMARKETS_PUBLIC_TEMPLATE =
  process.env.SPACEBOT_AIMARKETS_PUBLIC_URL_TEMPLATE ||
  'https://{userId}.spacebot.aimarkets.vn';
/** Where the marketplace API reaches the instance's own HTTP API (sshd toggle/key push). */
const AIMARKETS_API_TEMPLATE =
  process.env.SPACEBOT_AIMARKETS_API_URL_TEMPLATE ||
  process.env.SPACEBOT_AIMARKETS_PUBLIC_URL_TEMPLATE ||
  'https://{userId}.spacebot.aimarkets.vn';

function isMongoUserId(id) {
  return USER_ID_RE.test(String(id || '').trim());
}

function applyTemplate(template, userId) {
  const id = String(userId || '').trim().toLowerCase();
  if (!isMongoUserId(id)) return '';
  return String(template)
    .replace(/\{userId\}/gi, id)
    .replace(/\{tenant\}/gi, id)
    .replace(/\/$/, '');
}

function aimarketsPublicBase(userId) {
  return applyTemplate(AIMARKETS_PUBLIC_TEMPLATE, userId);
}

function aimarketsApiBase(userId) {
  return applyTemplate(AIMARKETS_API_TEMPLATE, userId);
}

/**
 * SpaceBot's dashboard reads its bearer token from `localStorage` and has no
 * `?token=` login flow, so we hand the buyer's own token over in the URL hash.
 * SpaceBot moves it into `localStorage` before the SPA boots and clears the hash.
 * The token is HMAC(seed, userId), not a secret shared by every buyer.
 */
function resolveDashboardToken(userId) {
  return dashboardTokenForUser(userId);
}

function buildLaunchUrl({ uiBaseUrl, userId, token }) {
  const base = String(uiBaseUrl || '')
    .replace(/^wss:/i, 'https:')
    .replace(/^ws:/i, 'http:')
    .replace(/^http:\/\//i, 'https://')
    .replace(/\/$/, '');
  if (!base || !userId) return null;

  const params = new URLSearchParams({
    userId: String(userId),
    audience: 'aimarkets',
    session: `market-${userId}`,
    autoConnect: 'true',
  });
  if (token) params.set('autoLogin', 'true');
  const hash = token ? `#${params.toString()}&token=${encodeURIComponent(token)}` : '';
  return `${base}/?${params.toString()}${hash}`;
}

function slugUser(user) {
  const base = String(user?.email || user?.name || user?._id || 'user')
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 18);
  const idShort = String(user?._id || 'anon').slice(-6);
  return `sb-${base || 'user'}-${idShort}`;
}

/** sshd in the SpaceBot image listens on 2222 and runs as root. */
function resolveSshTarget(user, body = {}) {
  const hostTemplate =
    process.env.SPACEBOT_SSH_HOST_TEMPLATE ||
    process.env.SPACEBOT_SSH_HOST ||
    '{userId}.spacebot.aimarkets.vn';
  const userId = String(user?._id || '').trim().toLowerCase();
  const ownHost = hostTemplate
    .replace(/\{userId\}/g, userId)
    .replace(/\{username\}/g, slugUser(user))
    .replace(/\{email\}/g, String(user?.email || '').split('@')[0])
    .trim()
    .toLowerCase();
  // The client can never choose the SSH host, port, or user.
  const host = ownHost;
  const port = Number(process.env.SPACEBOT_SSH_PORT || 2222);
  const username =
    String(process.env.SPACEBOT_SSH_USER || '').trim() || 'root';
  return { host, port: Number.isFinite(port) && port > 0 ? port : 2222, username };
}

function buildSshCommand({ username, host, port, keyPath = './spacebot_key' }) {
  const portPart = port && Number(port) !== 22 ? ` -p ${port}` : '';
  return `ssh -i ${keyPath}${portPart} ${username}@${host}`;
}

function serviceSecretOk(req) {
  const expected = String(process.env.AIMARKETS_SERVICE_SECRET || '').trim();
  if (!expected) return false;
  const got = String(
    req.headers['x-service-secret'] || req.headers['x-aimarkets-service-secret'] || '',
  ).trim();
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readSpacebotUserId(req) {
  return String(
    req.body?.userId ||
      req.body?.user_id ||
      req.query?.userId ||
      req.query?.user_id ||
      req.headers['x-aimarkets-user-id'] ||
      '',
  )
    .trim()
    .toLowerCase();
}

/** Enable sshd and install the buyer's public key on their SpaceBot instance. */
async function pushSshAccess({ apiBase, token, publicKey }) {
  const base = String(apiBase || '').replace(/\/$/, '');
  if (!base) return { ok: false, message: 'SpaceBot URL not configured.' };

  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const results = await Promise.all([
    fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ssh_enabled: true }),
      signal: AbortSignal.timeout(10000),
    }).catch((err) => ({ ok: false, error: err })),
    fetch(`${base}/api/ssh/authorized-key`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ public_key: publicKey }),
      signal: AbortSignal.timeout(10000),
    }).catch((err) => ({ ok: false, error: err })),
  ]);

  const failed = results.find((r) => !r || !r.ok);
  if (failed) {
    const error = failed.error ? String(failed.error.message || failed.error) : `HTTP ${failed.status || 'error'}`;
    return { ok: false, message: `SpaceBot rejected the SSH key (${error}).` };
  }
  return { ok: true };
}

router.post('/launch', authenticate, async (req, res, next) => {
  try {
    const blocked = spacebotUnlistedError();
    return res.status(blocked.status).json({ success: false, code: blocked.code, message: blocked.message });
  } catch (err) {
    next(err);
  }
});

router.post('/device-pairings/approve', authenticate, async (_req, res) => {
  return res.json({
    success: true,
    skipped: true,
    message: 'SpaceBot has no device pairing — auto-login uses the dashboard bearer token.',
  });
});

router.post('/ssh/generate', authenticate, async (req, res, next) => {
  try {
    const blocked = spacebotUnlistedError();
    return res.status(blocked.status).json({ success: false, code: blocked.code, message: blocked.message });
  } catch (err) {
    next(err);
  }
});

router.get('/ssh/active', authenticate, async (req, res, next) => {
  try {
    const agentId = String(req.query.agentId || 'spacebot');
    const session = await SshSession.findOne({
      user: req.user._id,
      agentId,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!session) {
      return res.json({ success: true, active: false, session: null });
    }

    const unset = legacySecretUnset(session);
    if (unset) {
      const set = session.password ? passwordStorage(session.password) : {};
      await SshSession.updateOne({ _id: session._id }, { $set: set, $unset: unset });
    }
    return res.json({
      success: true,
      active: true,
      session: {
        ...publicSshSession(session),
        note: 'Valid for 60 minutes. Secrets from this session are not returned again.',
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/ssh/revoke', authenticate, async (req, res, next) => {
  try {
    const agentId = String(req.body?.agentId || 'spacebot');
    await SshSession.updateMany(
      { user: req.user._id, agentId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.get('/usage/check', async (req, res, next) => {
  try {
    const viaSecret = serviceSecretOk(req);
    const userId = readSpacebotUserId(req);
    if (!viaSecret) {
      return authenticate(req, res, async () => {
        try {
          const uid = String(req.user._id);
          const { available, balance, held } = await getAvailableBalance(req.user._id);
          const subscription = await getSubscriptionStatus(req.user, 'spacebot');
          return res.json({
            allowed: available >= 0 && subscription.active,
            subscription,
            available,
            balance,
            held,
            userId: uid,
            markup: AIMARKETS_PROVIDER_MARKUP,
          });
        } catch (e) {
          next(e);
        }
      });
    }
    if (!USER_ID_RE.test(userId)) {
      return res.status(400).json({ allowed: false, message: 'user_id required' });
    }
    const { available, balance, held } = await getAvailableBalance(
      new mongoose.Types.ObjectId(userId),
    );
    const subscribed = await hasActiveSubscriptionByUserId(userId, 'spacebot');
    return res.json({
      allowed: subscribed,
      ...(subscribed ? {} : { reason: 'subscription_required' }),
      available,
      balance,
      held,
      userId,
      markup: AIMARKETS_PROVIDER_MARKUP,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/usage', async (req, res, next) => {
  const runCharge = async (userId) => {
    if (!USER_ID_RE.test(userId)) {
      return res.status(400).json({ success: false, message: 'user_id required' });
    }
    const model = String(req.body?.model || '').trim();
    if (model && isPhhotelModelId(model)) {
      return res.status(403).json({
        success: false,
        message: 'PHHotel models cannot be billed on AI Markets SpaceBot.',
        model,
      });
    }
    const inputTokens = Math.max(0, Math.floor(Number(req.body?.inputTokens) || 0));
    const outputTokens = Math.max(0, Math.floor(Number(req.body?.outputTokens) || 0));
    const markup =
      Number.isFinite(Number(req.body?.markup)) && Number(req.body.markup) >= 0
        ? Number(req.body.markup)
        : AIMARKETS_PROVIDER_MARKUP;
    let cost = Number(req.body?.cost);
    if (!Number.isFinite(cost) || cost < 0) {
      cost = computeOpenClawSellCost({ model, inputTokens, outputTokens, markup });
    }
    cost = Math.round(cost * 1e6) / 1e6;
    if (!(cost > 0)) {
      return res.json({
        success: true,
        charged: 0,
        skipped: true,
        reason: 'zero_cost',
        model,
        inputTokens,
        outputTokens,
        markup,
      });
    }
    const oid = new mongoose.Types.ObjectId(userId);
    const { available } = await getAvailableBalance(oid);
    if (available + 1e-9 < cost) {
      return res.status(402).json({
        success: false,
        message: `Insufficient wallet (need $${cost.toFixed(6)}, available $${available.toFixed(4)}).`,
        cost,
        available,
      });
    }
    await WalletTx.create({
      user: oid,
      type: 'debit',
      amount: cost,
      currency: 'USD',
      note: `SpaceBot ${model || 'llm'} (+${Math.round(markup * 100)}% provider markup) in=${inputTokens} out=${outputTokens}`,
      meta: {
        channel: 'spacebot',
        audience: 'aimarkets',
        model: model || '',
        inputTokens,
        outputTokens,
        markup,
        providerCost: markup > 0 ? Math.round((cost / (1 + markup)) * 1e6) / 1e6 : cost,
      },
    });
    return res.json({
      success: true,
      charged: cost,
      model,
      inputTokens,
      outputTokens,
      markup,
      userId,
    });
  };

  try {
    if (serviceSecretOk(req)) {
      return runCharge(readSpacebotUserId(req));
    }
    return authenticate(req, res, async () => {
      try {
        await runCharge(String(req.user._id));
      } catch (e) {
        next(e);
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

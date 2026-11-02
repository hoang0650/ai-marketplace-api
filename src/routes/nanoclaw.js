const ByokOwner = require('../models/User');
const { effectiveStatus: byokOwnerStatus } = require('../utils/moderation');
const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { authenticate } = require('../middleware/auth');
const SshSession = require('../models/SshSession');
const WalletTx = require('../models/WalletTx');
const ProviderApiKey = require('../models/ProviderApiKey');
const AgentProviderSetting = require('../models/AgentProviderSetting');
const { openSecret } = require('../utils/secret-box');
const { getByokProvider } = require('../utils/byok-providers');
const { toOpenAICompatibleConnection } = require('./runtime-byok-claim');
const { issueRuntimeTicket } = require('../utils/runtime-sso-ticket');
const { getAvailableBalance } = require('../utils/wallet');
const {
  assertActiveSubscription,
  getSubscriptionStatus,
  hasActiveSubscriptionByUserId,
} = require('../finance/agent-subscription');
const {
  AIMARKETS_PROVIDER_MARKUP,
  computeOpenClawSellCost,
  isPhhotelModelId,
} = require('../utils/openclaw-pricing');

const router = express.Router();
const SSH_TTL_MS = 60 * 60 * 1000;
const USER_ID_RE = /^[a-f0-9]{24}$/i;
const MODEL_ID_RE = /^[\w.:/@+-]{1,200}$/;
const AIMARKETS_PUBLIC_TEMPLATE =
  process.env.NANOCLAW_AIMARKETS_PUBLIC_URL_TEMPLATE ||
  process.env.NANOCLAW_PROXVN_URL_TEMPLATE ||
  'https://{userId}.nanoclaw.aimarkets.vn';

function isMongoUserId(id) {
  return USER_ID_RE.test(String(id || '').trim());
}

function aimarketsPublicBase(userId) {
  const template = String(AIMARKETS_PUBLIC_TEMPLATE).trim();
  if (!template) return '';
  // Shared apex / legacy ProxVN (no {userId}): one URL for all buyers.
  if (!/\{userId\}/i.test(template) && !/\{tenant\}/i.test(template)) {
    return template.replace(/\/$/, '');
  }
  const id = String(userId || '').trim().toLowerCase();
  if (!isMongoUserId(id)) return '';
  return template
    .replace(/\{userId\}/gi, id)
    .replace(/\{tenant\}/gi, id)
    .replace(/\/$/, '');
}

/**
 * Buyer-scoped, short-lived ticket. Never disclose the runtime's admin secret.
 * The legacy single-dashboard runtime cannot consume these safely; buyer
 * launch remains disabled until a tenant-aware runtime is explicitly enabled.
 */
function resolveDashboardToken(user) {
  return issueRuntimeTicket({ runtime: 'nanoclaw', envPrefix: 'NANOCLAW', user });
}

/**
 * Launch URL on per-buyer host (https://{userId}.nanoclaw.aimarkets.vn).
 *
 * Default: /dashboard?session=market-{userId}… (same pattern as Hermes/OpenClaw).
 * The ticket stays in the fragment so proxies do not log it.
 */
function buildLaunchUrl({ uiBaseUrl, userId, token }) {
  const base = String(uiBaseUrl || '')
    .replace(/^wss:/i, 'https:')
    .replace(/^ws:/i, 'http:')
    .replace(/\/$/, '');
  if (!base || !userId) return null;

  const dashQs = new URLSearchParams({
    userId: String(userId),
    audience: 'aimarkets',
    session: `market-${userId}`,
    autoConnect: 'true',
  });

  // Token in hash (not query) to avoid access logs.
  if (token) {
    dashQs.set('autoLogin', 'true');
    return `${base}/dashboard?${dashQs.toString()}#token=${encodeURIComponent(token)}`;
  }
  return `${base}/dashboard?${dashQs.toString()}`;
}

function randomPassword(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function slugUser(user) {
  const base = String(user?.email || user?.name || user?._id || 'user')
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 18);
  const idShort = String(user?._id || 'anon').slice(-6);
  return `nc-${base || 'user'}-${idShort}`;
}

function resolveSshTarget(user, body = {}) {
  const hostTemplate =
    process.env.NANOCLAW_SSH_HOST_TEMPLATE ||
    process.env.NANOCLAW_SSH_HOST ||
    '{userId}.nanoclaw.aimarkets.vn';
  const userId = String(user?._id || 'anon');
  const allowCustom = process.env.NANOCLAW_SSH_ALLOW_CUSTOM_HOST === '1';
  // Per-user scoping: the client can never choose the SSH host/port/user.
  const rawHost = String('')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  const isPhhotelHost = /(^|\.)phhotel\.vn$/i.test(rawHost);
  const isAimarketsHost =
    /(^|\.)nanoclaw\.aimarkets\.vn$/i.test(rawHost) || /(^|\.)aimarkets\.vn$/i.test(rawHost);
  const hostFromBody =
    rawHost && !isPhhotelHost && (allowCustom || isAimarketsHost) ? rawHost : '';
  const host =
    hostFromBody ||
    (hostTemplate
      ? hostTemplate
          .replace(/\{userId\}/g, userId)
          .replace(/\{username\}/g, slugUser(user))
          .replace(/\{email\}/g, String(user?.email || '').split('@')[0])
      : '');
  const port = Number(process.env.NANOCLAW_SSH_PORT || 22);
  const username =
    String(process.env.NANOCLAW_SSH_USER || '').trim() || slugUser(user);
  return { host, port: Number.isFinite(port) && port > 0 ? port : 22, username };
}

function buildSshCommand({ username, host, port, password }) {
  const portPart = port && Number(port) !== 22 ? ` -p ${port}` : '';
  const base = `ssh${portPart} ${username}@${host}`;
  return {
    command: base,
    withPasswordHint: `sshpass -p '${password}' ${base}`,
  };
}

function serviceSecretOk(req) {
  const expected = String(process.env.AIMARKETS_SERVICE_SECRET || '').trim();
  if (!expected) return false;
  const got = String(
    req.headers['x-service-secret'] || req.headers['x-aimarkets-service-secret'] || '',
  ).trim();
  return got && got === expected;
}

function readNanoclawUserId(req) {
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

router.post('/launch', authenticate, async (req, res, next) => {
  try {
    if (process.env.NANOCLAW_BUYER_RUNTIME_ENABLED !== '1') {
      return res.status(503).json({ success: false, code: 'RUNTIME_ISOLATION_MAINTENANCE', message: 'NanoClaw đang bảo trì cơ chế xác thực và API key riêng cho từng người dùng. Vui lòng thử lại sau.' });
    }
    const userId = String(req.user?._id || req.user?.id || '').trim();
    if (!isMongoUserId(userId)) {
      return res.status(400).json({
        success: false,
        message: 'NanoClaw AI Markets needs a signed-in marketplace user id.',
      });
    }
    await assertActiveSubscription(req.user, 'nanoclaw');

    const token = resolveDashboardToken(req.user);
    if (!token) return res.status(503).json({ success: false, code: 'RUNTIME_SSO_UNAVAILABLE', message: 'NanoClaw buyer SSO is not configured.' });
    // Token optional when dashboard has no DASHBOARD_SECRET (open tunnel via ProxVN).
    const uiBase = aimarketsPublicBase(userId);
    const url = buildLaunchUrl({ uiBaseUrl: uiBase, userId, token });
    if (!url) {
      return res.status(503).json({
        success: false,
        message:
          'NanoClaw AI Markets is not configured. Set NANOCLAW_AIMARKETS_PUBLIC_URL_TEMPLATE (default https://{userId}.nanoclaw.aimarkets.vn).',
      });
    }

    return res.json({
      success: true,
      url,
      audience: 'aimarkets',
      userId,
      autoLogin: true,
      edge: 'proxvn',
      ...(token ? { token, gatewayToken: token } : {}),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/device-pairings/approve', authenticate, async (_req, res) => {
  return res.json({
    success: true,
    skipped: true,
    message: 'NanoClaw dashboard uses Bearer token login — no OpenClaw-style device pairing.',
  });
});

router.post('/ssh/generate', authenticate, async (req, res, next) => {
  try {
    await assertActiveSubscription(req.user, 'nanoclaw');
    const agentId = String(req.body?.agentId || 'nano-claw');
    const { host, port, username } = resolveSshTarget(req.user, req.body || {});

    if (!host) {
      return res.status(503).json({
        success: false,
        message:
          'SSH host not configured. Set NANOCLAW_SSH_HOST (or NANOCLAW_SSH_HOST_TEMPLATE) or pass host in the request body.',
      });
    }

    await SshSession.updateMany(
      { user: req.user._id, agentId, revokedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { revokedAt: new Date() } },
    );

    const password = randomPassword();
    const expiresAt = new Date(Date.now() + SSH_TTL_MS);
    const { command, withPasswordHint } = buildSshCommand({ username, host, port, password });

    const session = await SshSession.create({
      user: req.user._id,
      agentId,
      host,
      port,
      username,
      password,
      command,
      expiresAt,
    });

    return res.status(201).json({
      success: true,
      id: session._id.toString(),
      agentId,
      host,
      port,
      username,
      password,
      command,
      commandWithPassword: withPasswordHint,
      expiresAt: expiresAt.toISOString(),
      expiresInMinutes: 60,
      note: 'Valid for 60 minutes. Existing connections stay open after expiry.',
      howTo: [
        'On your desktop (Windows / macOS / Linux), open a terminal.',
        `Run: ${command}`,
        `When prompted for password, paste: ${password}`,
        'Or use sshpass (Linux/macOS): ' + withPasswordHint,
      ],
    });
  } catch (err) {
    next(err);
  }
});

router.get('/ssh/active', authenticate, async (req, res, next) => {
  try {
    const agentId = String(req.query.agentId || 'nano-claw');
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

    return res.json({
      success: true,
      active: true,
      session: {
        id: String(session._id),
        agentId: session.agentId,
        host: session.host,
        port: session.port,
        username: session.username,
        password: session.password,
        command: session.command,
        commandWithPassword: buildSshCommand(session).withPasswordHint,
        expiresAt: new Date(session.expiresAt).toISOString(),
        expiresInMinutes: Math.max(
          0,
          Math.round((new Date(session.expiresAt) - Date.now()) / 60000),
        ),
        note: 'Valid for 60 minutes. Existing connections stay open after expiry.',
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/ssh/revoke', authenticate, async (req, res, next) => {
  try {
    const agentId = String(req.body?.agentId || 'nano-claw');
    await SshSession.updateMany(
      { user: req.user._id, agentId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * BYOK provider for the buyer's NanoClaw agents: one of their saved keys
 * (/v1/openclaw/byok/keys) plus a model. No selection = AI Markets default model.
 */
router.get('/provider', authenticate, async (req, res, next) => {
  try {
    const setting = await AgentProviderSetting.findOne({ user: req.user._id, agent: 'nanoclaw' });
    return res.json({ success: true, selection: setting ? setting.toPublic() : null });
  } catch (err) {
    next(err);
  }
});

router.put('/provider', authenticate, async (req, res, next) => {
  try {
    const spec = getByokProvider(req.body?.provider);
    if (!spec) {
      return res.status(400).json({ success: false, message: 'Choose a provider.' });
    }
    const key = await ProviderApiKey.findOne({ user: req.user._id, provider: spec.id });
    if (!key || key.status !== 'active') {
      return res.status(400).json({
        success: false,
        code: 'KEY_REQUIRED',
        message: `Save and verify your ${spec.label} API key first.`,
      });
    }
    const model = String(req.body?.model || '').trim() || (spec.custom ? key.model : '');
    if (!MODEL_ID_RE.test(model)) {
      return res.status(400).json({ success: false, message: 'Enter a valid model id.' });
    }
    const setting = await AgentProviderSetting.findOneAndUpdate(
      { user: req.user._id, agent: 'nanoclaw' },
      { $set: { provider: spec.id, model } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return res.json({ success: true, selection: setting.toPublic() });
  } catch (err) {
    next(err);
  }
});

router.delete('/provider', authenticate, async (req, res, next) => {
  try {
    await AgentProviderSetting.deleteOne({ user: req.user._id, agent: 'nanoclaw' });
    return res.json({ success: true, selection: null });
  } catch (err) {
    next(err);
  }
});

/** NanoClaw host only (X-Service-Secret): the decrypted OpenAI-compatible connection for one buyer. */
router.get('/provider/resolve', async (req, res, next) => {
  try {
    if (!serviceSecretOk(req)) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const userId = readNanoclawUserId(req);
    if (!USER_ID_RE.test(userId)) {
      return res.status(400).json({ success: false, message: 'user_id required' });
    }
    res.set('Cache-Control', 'no-store');
    const owner = await ByokOwner.findById(userId).select('accountStatus suspendedUntil').lean();
    if (!owner || byokOwnerStatus(owner) !== 'active') return res.status(403).json({ success: false, message: 'Account unavailable' });
    const setting = await AgentProviderSetting.findOne({ user: userId, agent: 'nanoclaw' }).lean();
    if (!setting) return res.json({ success: true, userId, connection: null });
    const key = await ProviderApiKey.findOne({
      user: userId,
      provider: setting.provider,
      status: 'active',
    }).select('+secret');
    if (!key) return res.json({ success: true, userId, connection: null, reason: 'key_missing' });
    let apiKey;
    try {
      apiKey = openSecret(key.secret);
    } catch {
      console.warn(`[nanoclaw-provider] cannot decrypt key user=${userId} provider=${setting.provider}`);
      return res.json({ success: true, userId, connection: null, reason: 'key_unreadable' });
    }
    const conn = toOpenAICompatibleConnection({
      provider: setting.provider,
      apiKey,
      baseUrl: key.baseUrl,
      model: setting.model,
    });
    if (!conn) return res.json({ success: true, userId, connection: null, reason: 'provider_unsupported' });
    ProviderApiKey.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
    return res.json({
      success: true,
      userId,
      connection: { provider: conn.provider, baseUrl: conn.baseUrl, apiKey, model: setting.model },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/usage/check', async (req, res, next) => {
  try {
    const viaSecret = serviceSecretOk(req);
    let userId = readNanoclawUserId(req);
    if (!viaSecret) {
      return authenticate(req, res, async () => {
        try {
          const uid = String(req.user._id);
          const { available, balance, held } = await getAvailableBalance(req.user._id);
          const subscription = await getSubscriptionStatus(req.user, 'nanoclaw');
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
    const subscribed = await hasActiveSubscriptionByUserId(userId, 'nanoclaw');
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
        message: 'PHHotel models cannot be billed on AI Markets NanoClaw.',
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
      note: `NanoClaw ${model || 'llm'} (+${Math.round(markup * 100)}% provider markup) in=${inputTokens} out=${outputTokens}`,
      meta: {
        channel: 'nanoclaw',
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
      return runCharge(readNanoclawUserId(req));
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

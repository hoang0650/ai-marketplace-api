const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { authenticate } = require('../middleware/auth');
const SshSession = require('../models/SshSession');
const WalletTx = require('../models/WalletTx');
const { AI_GATEWAY } = require('../utils/gateway-urls');
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
const {
  ensureHermesAccount,
  verifyHermesCredentials,
  issueHermesLoginTicket,
  consumeHermesLoginTicket,
  revealPassword,
} = require('../services/hermesAccounts');
const ProviderApiKey = require('../models/ProviderApiKey');
const AgentProviderSetting = require('../models/AgentProviderSetting');
const { openSecret } = require('../utils/secret-box');
const { getByokProvider } = require('../utils/byok-providers');
const { toOpenAICompatibleConnection } = require('./runtime-byok-claim');
const { serviceSecretOk } = require('../utils/service-secret');

const router = express.Router();
const SSH_TTL_MS = 60 * 60 * 1000;
const USER_ID_RE = /^[a-f0-9]{24}$/i;
const MODEL_ID_RE = /^[\w.:/@+-]{1,200}$/;
const AIMARKETS_PUBLIC_TEMPLATE =
  process.env.HERMES_AIMARKETS_PUBLIC_URL_TEMPLATE || 'https://{userId}.hermes.aimarkets.vn';

function isMongoUserId(id) {
  return USER_ID_RE.test(String(id || '').trim());
}

function aimarketsPublicBase(userId) {
  const id = String(userId || '').trim().toLowerCase();
  if (!isMongoUserId(id)) return '';
  return String(AIMARKETS_PUBLIC_TEMPLATE)
    .replace(/\{userId\}/gi, id)
    .replace(/\{tenant\}/gi, id)
    .replace(/\/$/, '');
}

/**
 * Launch deep link: /login?autoLogin=true&provider=aimarkets&next=...#ticket=<single-use>.
 * The ticket is short-lived, single-use and sits in the URL fragment, so it never reaches
 * server/proxy access logs or Referer headers. The buyer's password is never put in the URL.
 * Hermes' login page submits it as username "__aimarkets_ticket__" + password=ticket and the
 * aimarkets auth provider redeems it via POST /v1/hermes/auth/verify { ticket }.
 */
const HERMES_TICKET_USERNAME = '__aimarkets_ticket__';

function buildDashboardUrl({ uiBaseUrl, userId, ticket, provider = 'aimarkets' }) {
  const base = String(uiBaseUrl || '')
    .replace(/^wss:/i, 'https:')
    .replace(/^ws:/i, 'http:')
    .replace(/^http:\/\//i, 'https://')
    .replace(/\/$/, '');
  if (!base || !userId) return null;
  if (!/^https:\/\//i.test(base)) {
    return null;
  }

  const nextQs = new URLSearchParams({
    userId: String(userId),
    audience: 'aimarkets',
    session: `market-${userId}`,
    profile: `market-${userId}`,
    autoConnect: 'true',
  });
  const loginQs = new URLSearchParams();
  loginQs.set('autoLogin', 'true');
  loginQs.set('provider', String(provider || 'aimarkets'));
  loginQs.set('next', `/?${nextQs.toString()}`);
  const hash = ticket ? `#${new URLSearchParams({ ticket: String(ticket) }).toString()}` : '';
  return `${base}/login?${loginQs.toString()}${hash}`;
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
  return `hm-${base || 'user'}-${idShort}`;
}

function resolveSshTarget(user, body = {}) {
  const hostTemplate =
    process.env.HERMES_SSH_HOST_TEMPLATE ||
    process.env.HERMES_SSH_HOST ||
    '{userId}.hermes.aimarkets.vn';
  const userId = String(user?._id || 'anon');
  const allowCustom = process.env.HERMES_SSH_ALLOW_CUSTOM_HOST === '1';
  // Per-user scoping: the client can never choose the SSH host/port/user.
  const rawHost = String('')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  const isPhhotelHost = /(^|\.)phhotel\.vn$/i.test(rawHost);
  const isAimarketsHost =
    /(^|\.)hermes\.aimarkets\.vn$/i.test(rawHost) || /(^|\.)aimarkets\.vn$/i.test(rawHost);
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
  const port = Number(process.env.HERMES_SSH_PORT || 22);
  const username =
    String(process.env.HERMES_SSH_USER || '').trim() || slugUser(user);
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

function aiAdminHeaders(req) {
  const serviceToken = process.env.HERMES_BEARER_TOKEN || process.env.NEST_API_TOKEN || '';
  const incoming = String(req.headers?.authorization || '').trim();
  const headers = { Accept: 'application/json' };
  if (incoming.toLowerCase().startsWith('bearer ')) headers.Authorization = incoming;
  else if (serviceToken) headers.Authorization = `Bearer ${serviceToken}`;
  const secret = process.env.PYTHON_AI_SHARED_SECRET || process.env.NEST_SERVICE_AUTH_SECRET || '';
  if (secret) headers['X-Service-Secret'] = secret;
  return headers;
}

function aiBaseUrl() {
  return String(process.env.AI_URL || process.env.PYTHON_AI_ENDPOINT || AI_GATEWAY || '').replace(
    /\/$/,
    '',
  );
}


function readHermesUserId(req) {
  return String(
    req.body?.user_id ||
      req.body?.userId ||
      req.query?.user_id ||
      req.query?.userId ||
      req.user?._id ||
      req.user?.id ||
      '',
  )
    .trim()
    .toLowerCase();
}

router.post('/launch', authenticate, async (req, res, next) => {
  try {
    const userId = String(req.user?._id || req.user?.id || '').trim();
    if (!isMongoUserId(userId)) {
      return res.status(400).json({
        success: false,
        message: 'Hermes AI Markets needs a signed-in marketplace user id.',
      });
    }
    await assertActiveSubscription(req.user, 'hermes');

    const account = await ensureHermesAccount(req.user);
    const uiBase = aimarketsPublicBase(userId);
    const ticket = uiBase ? await issueHermesLoginTicket(userId) : '';
    const url = buildDashboardUrl({
      uiBaseUrl: uiBase,
      userId,
      ticket,
      provider: 'aimarkets',
    });

    if (!url) {
      return res.status(503).json({
        success: false,
        message:
          'Hermes AI Markets is not configured. Set HERMES_AIMARKETS_PUBLIC_URL_TEMPLATE.',
      });
    }

    return res.json({
      success: true,
      url,
      audience: 'aimarkets',
      userId,
      autoLogin: true,
      username: account.username,
      password: revealPassword(account.password),
      profile: account.profile,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Hermes AimarketsAuthProvider calls this to verify buyer credentials.
 * Auth: X-Service-Secret === AIMARKETS_SERVICE_SECRET
 */
router.post('/auth/verify', async (req, res, next) => {
  try {
    if (!serviceSecretOk(req)) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    // Launch ticket: either { ticket } or the login-form convention username=__aimarkets_ticket__.
    const ticket = String(req.body?.ticket || (username === HERMES_TICKET_USERNAME ? password : '') || '');
    const verified = ticket
      ? await consumeHermesLoginTicket(ticket)
      : await verifyHermesCredentials(username, password);
    if (!verified) {
      return res.status(401).json({ ok: false, message: 'Invalid credentials' });
    }
    if (!(await hasActiveSubscriptionByUserId(verified.userId, 'hermes'))) {
      return res.status(402).json({ ok: false, code: 'AGENT_SUBSCRIPTION_REQUIRED', message: 'Hermes subscription expired' });
    }
    return res.json({
      ok: true,
      userId: verified.userId,
      username: verified.username,
      profile: verified.profile,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Hermes pairing differs from OpenClaw device pairing.
 * Keep endpoint for app UX parity; succeed as no-op when no upstream.
 */
router.post('/device-pairings/approve', authenticate, async (req, res, next) => {
  try {
    const userId = String(req.user?._id || req.user?.id || '').trim();
    const aiUrl = aiBaseUrl();
    if (aiUrl) {
      try {
        const qs = new URLSearchParams({ audience: 'aimarkets', user_id: userId });
        const body = {
          ...(req.body || {}),
          user_id: userId,
        };
        const upstream = await fetch(`${aiUrl}/admin/hermes/device-pairings/approve?${qs}`, {
          method: 'POST',
          headers: { ...aiAdminHeaders(req), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await upstream.json().catch(() => ({}));
        if (upstream.ok) {
          return res.status(upstream.status).json({
            success: data?.success !== false,
            message: data?.message,
          });
        }
      } catch (err) {
        console.warn('[hermes/approve] upstream failed', err?.message || err);
      }
    }
    return res.json({
      success: true,
      skipped: true,
      message: 'Hermes dashboard does not require OpenClaw-style device pairing.',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/ssh/generate', authenticate, async (req, res, next) => {
  try {
    await assertActiveSubscription(req.user, 'hermes');
    const agentId = String(req.body?.agentId || 'hermes');
    const { host, port, username } = resolveSshTarget(req.user, req.body || {});

    if (!host) {
      return res.status(503).json({
        success: false,
        message:
          'SSH host not configured. Set HERMES_SSH_HOST (or HERMES_SSH_HOST_TEMPLATE) or pass host in the request body.',
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
    const agentId = String(req.query.agentId || 'hermes');
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
        expiresInMinutes: Math.max(0, Math.round((new Date(session.expiresAt) - Date.now()) / 60000)),
        note: 'Valid for 60 minutes. Existing connections stay open after expiry.',
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/ssh/revoke', authenticate, async (req, res, next) => {
  try {
    const agentId = String(req.body?.agentId || 'hermes');
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
    let userId = readHermesUserId(req);
    if (!viaSecret) {
      return authenticate(req, res, async () => {
        try {
          const uid = String(req.user._id);
          const { available, balance, held } = await getAvailableBalance(req.user._id);
          const subscription = await getSubscriptionStatus(req.user, 'hermes');
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
    const { available, balance, held } = await getAvailableBalance(new mongoose.Types.ObjectId(userId));
    const subscribed = await hasActiveSubscriptionByUserId(userId, 'hermes');
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
        message: 'PHHotel models cannot be billed on AI Markets Hermes.',
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
      note: `Hermes ${model || 'llm'} (+${Math.round(markup * 100)}% provider markup) in=${inputTokens} out=${outputTokens}`,
      meta: {
        channel: 'hermes',
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
      return runCharge(readHermesUserId(req));
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

/**
 * BYOK for this buyer's Hermes profile. No selection = Hermes has no platform key
 * (platform keys are not copied into the buyer profile).
 */
router.get('/provider', authenticate, async (req, res, next) => {
  try {
    const setting = await AgentProviderSetting.findOne({ user: req.user._id, agent: 'hermes' });
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
      { user: req.user._id, agent: 'hermes' },
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
    await AgentProviderSetting.deleteOne({ user: req.user._id, agent: 'hermes' });
    return res.json({ success: true, selection: null });
  } catch (err) {
    next(err);
  }
});

/** Hermes host only: the buyer's OpenAI-compatible connection. Never a platform key. */
router.get('/provider/resolve', async (req, res, next) => {
  try {
    if (!serviceSecretOk(req)) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const userId = readHermesUserId(req);
    if (!USER_ID_RE.test(userId)) {
      return res.status(400).json({ success: false, message: 'user_id required' });
    }
    res.set('Cache-Control', 'no-store');
    const setting = await AgentProviderSetting.findOne({ user: userId, agent: 'hermes' }).lean();
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
      console.warn(`[hermes-provider] cannot decrypt key user=${userId} provider=${setting.provider}`);
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

module.exports = router;
module.exports.buildDashboardUrl = buildDashboardUrl;
module.exports.HERMES_TICKET_USERNAME = HERMES_TICKET_USERNAME;

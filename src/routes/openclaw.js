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
const { issueMarketTicket, tenantGatewayToken } = require('../utils/openclaw-ticket');
const { serviceSecretOk } = require('../utils/service-secret');
const { issueIsolatedSshSession } = require('../services/ssh-sandbox');
const byokRoutes = require('./openclaw-byok');
const { approveOwnPairing, listOwnPairings, PairingError } = require('../services/openclaw-pairing');

const router = express.Router();
router.use('/byok', byokRoutes);
const SSH_TTL_MS = 60 * 60 * 1000; // 60 minutes
const USER_ID_RE = /^[a-f0-9]{24}$/i;
const AIMARKETS_PUBLIC_TEMPLATE =
  process.env.OPENCLAW_AIMARKETS_PUBLIC_URL_TEMPLATE || 'https://{userId}.openclaw.aimarkets.vn';

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

/** Adds the signed buyer ticket to the Control UI fragment (never the query string). */
function withMarketTicket(url, userId) {
  const ticket = issueMarketTicket(userId);
  if (!ticket || !url) return url;
  const [base, hash = ''] = String(url).split('#');
  const params = new URLSearchParams(hash);
  params.set('marketTicket', ticket);
  return `${base}#${params.toString()}`;
}

/** Puts this buyer's own gateway token in the Control UI fragment. */
function withAimarketsGatewayToken(url, userId) {
  const token = tenantGatewayToken(userId);
  if (!token || !url) return url;
  const [base, hash = ''] = String(url).split('#');
  const params = new URLSearchParams(hash);
  params.set('token', token);
  params.set('gatewayToken', token);
  params.delete('password');
  return `${base}#${params.toString()}`;
}

function buildHashUrl({ uiBaseUrl, gatewayUrl, token, password, session, userId }) {
  const base = String(uiBaseUrl || gatewayUrl || '')
    .replace(/^wss:/i, 'https:')
    .replace(/^ws:/i, 'http:')
    .replace(/^http:\/\//i, 'https://')
    .replace(/\/$/, '');
  if (!base || !gatewayUrl || !token) return null;
  if (!/^https:\/\//i.test(base)) return null;
  const gw = String(gatewayUrl)
    .replace(/^http:\/\//i, 'https://')
    .replace(/^ws:/i, 'wss:');
  const hash = new URLSearchParams({
    gatewayUrl: gw,
    token,
    gatewayToken: token,
    autoConnect: 'true',
    autoApprove: 'true',
    session: session || 'main',
    audience: 'aimarkets',
  });
  if (password && password !== token) hash.set('password', password);
  if (userId) hash.set('userId', String(userId));
  return `${base}/#${hash.toString()}`;
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
  return `oc-${base || 'user'}-${idShort}`;
}

/**
 * SSH target is derived from the signed-in buyer only. Client-supplied host,
 * port or username are ignored so a buyer can never point the generated
 * credentials (or the command shown on the setup page) at another user's
 * agent or a shared/root account.
 */
function resolveSshTarget(user, _body = {}) {
  const hostTemplate =
    process.env.OPENCLAW_SSH_HOST_TEMPLATE ||
    process.env.OPENCLAW_SSH_HOST ||
    '{userId}.openclaw.aimarkets.vn';
  const userId = String(user?._id || 'anon');
  const host = hostTemplate
    .replace(/\{userId\}/g, userId)
    .replace(/\{username\}/g, slugUser(user))
    .replace(/\{email\}/g, String(user?.email || '').split('@')[0]);
  const port = Number(process.env.OPENCLAW_SSH_PORT || 22);
  const username = slugUser(user);
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
  const serviceToken = process.env.OPENCLAW_BEARER_TOKEN || process.env.NEST_API_TOKEN || '';
  const incoming = String(req.headers?.authorization || '').trim();
  const headers = { Accept: 'application/json' };
  if (incoming.toLowerCase().startsWith('bearer ')) headers.Authorization = incoming;
  else if (serviceToken) headers.Authorization = `Bearer ${serviceToken}`;
  const secret = process.env.PYTHON_AI_SHARED_SECRET || process.env.NEST_SERVICE_AUTH_SECRET || '';
  if (secret) headers['X-Service-Secret'] = secret;
  return headers;
}

function aiBaseUrl() {
  return String(process.env.AI_URL || process.env.PYTHON_AI_ENDPOINT || AI_GATEWAY || '')
    .replace(/\/$/, '');
}

router.post('/launch', authenticate, async (req, res, next) => {
  try {
    const userId = String(req.user?._id || req.user?.id || '').trim();
    if (!isMongoUserId(userId)) {
      return res.status(400).json({
        success: false,
        message: 'OpenClaw AI Markets needs a signed-in marketplace user id.',
      });
    }
    await assertActiveSubscription(req.user, 'openclaw');

    const aiUrl = aiBaseUrl();
    if (aiUrl) {
      try {
        const qs = new URLSearchParams({
          audience: 'aimarkets',
          user_id: userId,
        });
        const upstream = await fetch(`${aiUrl}/admin/openclaw/direct-url?${qs}`, {
          headers: aiAdminHeaders(req),
        });
        const data = await upstream.json().catch(() => ({}));
        if (upstream.ok && data?.success && data?.url) {
          return res.json({
            success: true,
            url: withMarketTicket(withAimarketsGatewayToken(data.url, userId), userId),
            audience: 'aimarkets',
            userId,
            message: data.message,
          });
        }
      } catch (err) {
        console.warn('[openclaw/launch] aimarkets direct-url failed', err?.message || err);
      }
    }

    const uiBase = aimarketsPublicBase(userId);
    const gatewayUrl = uiBase.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
    const token = tenantGatewayToken(userId);
    if (!token) {
      return res.status(503).json({
        success: false,
        message:
          'OpenClaw gateway token missing. Set PYTHON_AI_SHARED_SECRET or NEST_SERVICE_AUTH_SECRET on the API and the OpenClaw gateway.',
      });
    }
    const url = withMarketTicket(
      buildHashUrl({
        uiBaseUrl: uiBase,
        gatewayUrl,
        token,
        session: `market-${userId}`,
        userId,
      }),
      userId
    );

    if (!url) {
      return res.status(503).json({
        success: false,
        message:
          'OpenClaw AI Markets is not configured. Set OPENCLAW_AIMARKETS_PUBLIC_URL_TEMPLATE and OPENCLAW_GATEWAY_TOKEN.',
      });
    }

    return res.json({
      success: true,
      url,
      audience: 'aimarkets',
      userId,
      autoLogin: true,
      gatewayToken: token,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/device-pairings/pending', authenticate, async (req, res, next) => {
  try {
    await assertActiveSubscription(req.user, 'openclaw');
    const pending = await listOwnPairings({ userId: String(req.user?._id || req.user?.id || ''), clientIp: req.ip });
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, pending });
  } catch (err) {
    if (err instanceof PairingError) {
      return res.status(err.status).json({ success: false, code: err.code, message: err.message, ...(err.disallowedScopes ? { disallowedScopes: err.disallowedScopes } : {}) });
    }
    next(err);
  }
});

/**
 * Approve one of the buyer's OWN pending device pairings (see services/openclaw-pairing).
 * Previously this proxied to AI_URL (default https://ai.aimarkets.vn), which has no
 * backend on the AI Markets stack, so every call failed with a 500 "Approve failed".
 */
router.post('/device-pairings/approve', authenticate, async (req, res, next) => {
  try {
    await assertActiveSubscription(req.user, 'openclaw');
    const result = await approveOwnPairing({
      userId: String(req.user?._id || req.user?.id || ''),
      clientIp: req.ip,
      requestId: req.body?.requestId || req.body?.request_id,
    });
    return res.json({ success: true, message: 'Device approved.', ...result });
  } catch (err) {
    if (err instanceof PairingError) {
      return res.status(err.status).json({ success: false, code: err.code, message: err.message, ...(err.disallowedScopes ? { disallowedScopes: err.disallowedScopes } : {}) });
    }
    next(err);
  }
});

/**
 * Temporary SSH: desktop → user sandbox/server (Featherless-style, 60 min).
 */
router.post('/ssh/generate', authenticate, async (req, res, next) => {
  try {
    // Nothing provisions a Linux/container user for these credentials yet, and the
    // OpenClaw gateway is one shared container. Handing out a password for the host
    // sshd would be a dead login at best and a shared/host account at worst, so fail
    // closed until each buyer has an isolated sandbox with a provisioner behind it.
    if (process.env.OPENCLAW_SSH_PER_USER_ISOLATION !== '1') {
      return res.status(403).json({
        success: false,
        code: 'ssh_not_isolated',
        message: 'SSH is disabled for OpenClaw until each buyer runs an isolated sandbox.',
      });
    }
    await assertActiveSubscription(req.user, 'openclaw');
    // Credentials are verified by the SSH sandbox gateway (infra/ssh-gateway) on a
    // non-22 port, which drops the login into this buyer's own sandbox container.
    // Only a scrypt hash is stored; the password is shown once in this response.
    const issued = await issueIsolatedSshSession({ SshSession, user: req.user, agentId: 'openclaw' });
    return res.status(201).json({
      success: true,
      id: issued.session._id.toString(),
      agentId: 'openclaw',
      authMethod: 'password',
      host: issued.host,
      port: issued.port,
      username: issued.username,
      password: issued.password,
      command: issued.command,
      commandWithPassword: `sshpass -p '${issued.password}' ${issued.command}`,
      expiresAt: issued.expiresAt.toISOString(),
      expiresInMinutes: 60,
      note: 'Valid for 60 minutes. The password is shown only once. Your sandbox and open connections close on expiry or revoke.',
      howTo: [
        'On your desktop (Windows / macOS / Linux), open a terminal.',
        `Run: ${issued.command}`,
        'When prompted for password, paste the password shown above.',
      ],
    });
  } catch (err) {
    next(err);
  }
});

router.get('/ssh/active', authenticate, async (req, res, next) => {
  try {
    const agentId = String(req.query.agentId || 'openclaw');
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
        // Isolated sessions store only a hash; the password was shown once at generation.
        ...(session.password
          ? { password: session.password, commandWithPassword: buildSshCommand(session).withPasswordHint }
          : { passwordShownOnce: true }),
        command: session.command,
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
    const agentId = String(req.body?.agentId || 'openclaw');
    await SshSession.updateMany(
      { user: req.user._id, agentId, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

function readOpenClawUserId(req) {
  return String(
    req.body?.user_id ||
      req.body?.userId ||
      req.query?.user_id ||
      req.query?.userId ||
      req.user?._id ||
      req.user?.id ||
      ''
  )
    .trim()
    .toLowerCase();
}

/**
 * Gateway plugin: check wallet before OpenClaw agent run (aimarkets only).
 * Auth: X-Service-Secret or buyer JWT.
 */
router.get('/usage/check', async (req, res, next) => {
  try {
    const viaSecret = serviceSecretOk(req);
    let userId = readOpenClawUserId(req);
    if (!viaSecret) {
      return authenticate(req, res, async () => {
        try {
          const uid = String(req.user._id);
          const { available, balance, held } = await getAvailableBalance(req.user._id);
          const subscription = await getSubscriptionStatus(req.user, 'openclaw');
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
    const subscribed = await hasActiveSubscriptionByUserId(userId, 'openclaw');
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

/**
 * Gateway plugin: charge wallet after LLM output (provider COGS + 25%).
 * Rejects PHHotel Nest stack model ids on the aimarkets surface.
 */
router.post('/usage', async (req, res, next) => {
  const runCharge = async (userId) => {
    if (!USER_ID_RE.test(userId)) {
      return res.status(400).json({ success: false, message: 'user_id required' });
    }
    const model = String(req.body?.model || '').trim();
    if (model && isPhhotelModelId(model)) {
      return res.status(403).json({
        success: false,
        message: 'PHHotel models cannot be billed on AI Markets OpenClaw.',
        model,
      });
    }
    const inputTokens = Math.max(0, Math.floor(Number(req.body?.inputTokens) || 0));
    const outputTokens = Math.max(0, Math.floor(Number(req.body?.outputTokens) || 0));
    // Buyer's own provider key: AI Markets sells the agent, not the tokens.
    if (req.body?.byok === true) {
      return res.json({
        success: true,
        charged: 0,
        skipped: true,
        reason: 'byok',
        model,
        inputTokens,
        outputTokens,
      });
    }
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
      note: `OpenClaw ${model || 'llm'} (+${Math.round(markup * 100)}% provider markup) in=${inputTokens} out=${outputTokens}`,
      meta: {
        channel: 'openclaw',
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
      return runCharge(readOpenClawUserId(req));
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

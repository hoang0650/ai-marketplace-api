const express = require('express');
const crypto = require('crypto');
const { authenticate } = require('../middleware/auth');
const SshSession = require('../models/SshSession');
const { AI_GATEWAY } = require('../utils/gateway-urls');

const router = express.Router();
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

function buildHashUrl({ uiBaseUrl, gatewayUrl, token, password, session, userId }) {
  const base = String(uiBaseUrl || gatewayUrl || '')
    .replace(/^wss:/i, 'https:')
    .replace(/^ws:/i, 'http:')
    .replace(/\/$/, '');
  if (!base || !gatewayUrl || !token) return null;
  const hash = new URLSearchParams({
    gatewayUrl,
    token,
    gatewayToken: token,
    password: password || '',
    autoConnect: 'true',
    autoApprove: 'true',
    session: session || 'main',
    audience: 'aimarkets',
  });
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

function resolveSshTarget(user, body = {}) {
  const hostTemplate =
    process.env.OPENCLAW_SSH_HOST_TEMPLATE ||
    process.env.OPENCLAW_SSH_HOST ||
    '{userId}.openclaw.aimarkets.vn';
  const userId = String(user?._id || 'anon');
  const allowCustom = process.env.OPENCLAW_SSH_ALLOW_CUSTOM_HOST === '1';
  const hostFromBody = allowCustom ? String(body.host || body.serverHost || '').trim() : '';
  const host =
    hostFromBody ||
    (hostTemplate
      ? hostTemplate
          .replace(/\{userId\}/g, userId)
          .replace(/\{username\}/g, slugUser(user))
          .replace(/\{email\}/g, String(user?.email || '').split('@')[0])
      : '');
  const port = Number(body.port || process.env.OPENCLAW_SSH_PORT || 22);
  const username =
    String(body.username || process.env.OPENCLAW_SSH_USER || '').trim() || slugUser(user);
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
            url: data.url,
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
    const token = process.env.OPENCLAW_GATEWAY_TOKEN || '';
    const url = buildHashUrl({
      uiBaseUrl: uiBase,
      gatewayUrl,
      token,
      password: process.env.OPENCLAW_GATEWAY_PASSWORD || token,
      session: `market-${userId}`,
      userId,
    });

    if (!url) {
      return res.status(503).json({
        success: false,
        message:
          'OpenClaw AI Markets is not configured. Set AI_URL or OPENCLAW_GATEWAY_TOKEN plus OPENCLAW_AIMARKETS_PUBLIC_URL_TEMPLATE.',
      });
    }

    return res.json({ success: true, url, audience: 'aimarkets', userId });
  } catch (err) {
    next(err);
  }
});

router.post('/device-pairings/approve', authenticate, async (req, res, next) => {
  try {
    const userId = String(req.user?._id || req.user?.id || '').trim();
    const aiUrl = aiBaseUrl();
    if (!aiUrl) {
      return res.status(503).json({ success: false, message: 'AI_URL is not configured.' });
    }
    const qs = new URLSearchParams({ audience: 'aimarkets', user_id: userId });
    const body = {
      ...(req.body || {}),
      role: req.body?.role || 'operator',
      scopes: req.body?.scopes || ['operator.read', 'operator.write', 'operator.admin', 'operator.pairing'],
      user_id: userId,
    };
    const upstream = await fetch(`${aiUrl}/admin/openclaw/device-pairings/approve?${qs}`, {
      method: 'POST',
      headers: { ...aiAdminHeaders(req), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await upstream.json().catch(() => ({}));
    return res.status(upstream.status === 404 ? 200 : upstream.status).json({
      success: data?.success !== false,
      message: data?.message,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Temporary SSH: desktop → user sandbox/server (Featherless-style, 60 min).
 */
router.post('/ssh/generate', authenticate, async (req, res, next) => {
  try {
    const agentId = String(req.body?.agentId || 'openclaw');
    const { host, port, username } = resolveSshTarget(req.user, req.body || {});

    if (!host) {
      return res.status(503).json({
        success: false,
        message:
          'SSH host not configured. Set OPENCLAW_SSH_HOST (or OPENCLAW_SSH_HOST_TEMPLATE) or pass host in the request body.',
      });
    }

    await SshSession.updateMany(
      { user: req.user._id, agentId, revokedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { revokedAt: new Date() } }
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

module.exports = router;

const express = require('express');
const crypto = require('crypto');
const { optionalAuth, authenticate } = require('../middleware/auth');
const SshSession = require('../models/SshSession');

const router = express.Router();
const SSH_TTL_MS = 60 * 60 * 1000; // 60 minutes

function buildHashUrl({ uiBaseUrl, gatewayUrl, token, password, session }) {
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
  });
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
  const hostTemplate = process.env.OPENCLAW_SSH_HOST_TEMPLATE || process.env.OPENCLAW_SSH_HOST || '';
  const userId = String(user?._id || 'anon');
  const hostFromBody = String(body.host || body.serverHost || '').trim();
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

router.post('/launch', optionalAuth, async (req, res, next) => {
  try {
    const aiUrl = String(process.env.AI_URL || process.env.PYTHON_AI_ENDPOINT || '').replace(/\/$/, '');
    const tenantId = String(process.env.OPENCLAW_TENANT_ID || req.body?.tenantId || '').trim();
    const userId = String(req.body?.userId || req.user?._id || req.user?.id || '').trim();
    const serviceToken =
      process.env.OPENCLAW_BEARER_TOKEN ||
      process.env.NEST_API_TOKEN ||
      req.headers.authorization?.replace(/^Bearer\s+/i, '') ||
      '';

    if (aiUrl && tenantId) {
      try {
        const qs = new URLSearchParams({
          tenant_id: tenantId,
          current_hotel_id: tenantId,
          selected_hotel_id: tenantId,
        });
        if (userId) qs.set('user_id', userId);
        const upstream = await fetch(`${aiUrl}/admin/openclaw/direct-url?${qs}`, {
          headers: serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {},
        });
        const data = await upstream.json().catch(() => ({}));
        if (upstream.ok && data?.success && data?.url) {
          return res.json({
            success: true,
            url: data.url,
            gatewayUrl: data.gatewayUrl || data.gateway_url,
            token: data.token,
            message: data.message,
          });
        }
      } catch (err) {
        console.warn('[openclaw/launch] direct-url failed', err?.message || err);
      }
    }

    const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || process.env.OPENCLAW_PUBLIC_GATEWAY_URL || '';
    const token = process.env.OPENCLAW_GATEWAY_TOKEN || '';
    const uiBaseUrl = process.env.OPENCLAW_UI_BASE_URL || '';
    const url = buildHashUrl({
      uiBaseUrl,
      gatewayUrl,
      token,
      password: process.env.OPENCLAW_GATEWAY_PASSWORD || '',
      session: userId ? `market-${userId}` : 'main',
    });

    if (!url) {
      return res.status(503).json({
        success: false,
        message:
          'OpenClaw not configured. Set AI_URL+OPENCLAW_TENANT_ID+OPENCLAW_BEARER_TOKEN or OPENCLAW_GATEWAY_URL+OPENCLAW_GATEWAY_TOKEN+OPENCLAW_UI_BASE_URL.',
      });
    }

    return res.json({ success: true, url, gatewayUrl, token });
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

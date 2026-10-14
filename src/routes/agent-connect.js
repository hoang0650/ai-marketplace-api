const express = require('express');
const User = require('../models/User');
const SshSession = require('../models/SshSession');
const { authenticate } = require('../middleware/auth');
const { effectiveStatus } = require('../utils/moderation');
const { assertActiveSubscription } = require('../finance/agent-subscription');
const { issueCommandToken, verifyCommandToken, readCommandToken, RUNTIMES } = require('../utils/agent-command-token');
const { approveOwnPairing, PairingError } = require('../services/openclaw-pairing');
const { issueRuntimeTicket } = require('../utils/runtime-sso-ticket');
const { applyTemplate, buildSsoLaunchUrl } = require('./runtime-sso');

/**
 * Per-user "connect it yourself" commands for the setup page (all agent types).
 *
 * Every command carries a short-lived token bound to (this buyer, this runtime,
 * one action). The server derives the target from the token's user id only; a
 * request can never name another user, agent or host. No shared SSH keys and no
 * gateway/admin tokens are ever returned.
 */
const router = express.Router();

const API_HOST = () => String(process.env.AIMARKETS_API_HOST || 'https://api.aimarkets.vn').replace(/\/$/, '');
const COMMAND_TTL_MS = 10 * 60 * 1000;

/** What each runtime supports. `sso` runtimes expose an AI Markets SSO endpoint. */
const RUNTIME_FEATURES = {
  openclaw: { label: 'OpenClaw', pairing: true, ssh: true },
  hermes: { label: 'Hermes', pairing: false, ssh: true },
  nanoclaw: { label: 'NanoClaw', pairing: false, ssh: true },
  spacebot: { label: 'SpaceBot', pairing: false, ssh: true },
  paperclip: {
    label: 'Paperclip',
    pairing: false,
    ssh: false,
    sso: { envPrefix: 'PAPERCLIP', template: 'https://{userId}.paperclip.aimarkets.vn', path: '/api/auth/aimarkets/sso' },
  },
  openwebui: {
    label: 'Open WebUI',
    pairing: false,
    ssh: false,
    sso: { envPrefix: 'OPENWEBUI', template: 'https://{userId}.openwebui.aimarkets.vn', path: '/api/v1/aimarkets/sso' },
  },
};

function sendError(res, err, next) {
  if (err instanceof PairingError) {
    return res.status(err.status).json({ success: false, code: err.code, message: err.message });
  }
  const status = Number(err?.status || err?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return res.status(status).json({ success: false, code: err.code, message: err.message });
  }
  return next(err);
}

function runtimeParam(req, res) {
  const runtime = String(req.params.runtime || '').toLowerCase();
  if (!RUNTIMES.has(runtime) || !RUNTIME_FEATURES[runtime]) {
    res.status(404).json({ success: false, message: 'Unknown agent type.' });
    return '';
  }
  return runtime;
}

/** Accepts the buyer's normal login (JWT) or a command token for exactly this runtime + action. */
function userOrCommandToken(action) {
  return async (req, res, next) => {
    const runtime = runtimeParam(req, res);
    if (!runtime) return undefined;
    const token = readCommandToken(req);
    if (!token) return authenticate(req, res, next);
    const claims = verifyCommandToken(token, { runtime, action });
    if (!claims) {
      return res.status(401).json({
        success: false,
        code: 'bad_command_token',
        message: 'This command has expired or is not valid for this agent. Copy a fresh one from aimarkets.vn.',
      });
    }
    try {
      const user = await User.findById(claims.uid).lean();
      if (!user) return res.status(401).json({ success: false, message: 'User not found.' });
      if (effectiveStatus(user, 'accountStatus') !== 'active') {
        return res.status(403).json({ success: false, message: 'Account is not active.' });
      }
      req.user = user;
      req.commandToken = claims;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildCommands({ runtime, userId, ssh }) {
  const f = RUNTIME_FEATURES[runtime];
  const api = API_HOST();
  const expiresAt = new Date(Date.now() + COMMAND_TTL_MS).toISOString();
  const commands = [];
  if (f.pairing) {
    const token = issueCommandToken({ userId, runtime, action: 'pairing.approve', ttlMs: COMMAND_TTL_MS });
    if (token) {
      commands.push({
        id: 'pairing-approve',
        title: 'Approve a device pairing request',
        description: 'Approves only a pending request opened from your own workspace. Replace <REQUEST_ID>.',
        command: `curl -fsS -X POST ${api}/v1/agent-connect/${runtime}/pairing/approve -H ${q(`Authorization: AgentCommand ${token}`)} -H 'Content-Type: application/json' -d '{"requestId":"<REQUEST_ID>"}'`,
        scope: `${runtime}:${userId}:pairing.approve`,
        expiresAt,
      });
    }
  }
  if (f.sso) {
    const token = issueCommandToken({ userId, runtime, action: 'launch', ttlMs: COMMAND_TTL_MS });
    if (token) {
      commands.push({
        id: 'cli-launch',
        title: `Get a sign-in link for your ${f.label}`,
        description: 'Prints a one-time (2 minute) sign-in link for your own workspace.',
        command: `curl -fsS -X POST ${api}/v1/agent-connect/${runtime}/launch -H ${q(`Authorization: AgentCommand ${token}`)}`,
        scope: `${runtime}:${userId}:launch`,
        expiresAt,
      });
    }
  }
  if (f.ssh) {
    commands.push(
      ssh
        ? {
            id: 'ssh-connect',
            title: 'SSH into your agent',
            description: 'Temporary login for your own agent only. Paste the password when asked.',
            command: ssh.command,
            scope: `${runtime}:${userId}:ssh`,
            expiresAt: new Date(ssh.expiresAt).toISOString(),
          }
        : {
            id: 'ssh-connect',
            title: 'SSH into your agent',
            description: 'Generate a temporary SSH login in the "SSH access" step first.',
            command: null,
            scope: `${runtime}:${userId}:ssh`,
            expiresAt: null,
          }
    );
  }
  return commands;
}

router.get('/:runtime/commands', authenticate, async (req, res, next) => {
  try {
    const runtime = runtimeParam(req, res);
    if (!runtime) return undefined;
    const userId = String(req.user?._id || '').toLowerCase();
    await assertActiveSubscription(req.user, runtime);
    const ssh = RUNTIME_FEATURES[runtime].ssh
      ? await SshSession.findOne({ user: req.user._id, agentId: runtime, revokedAt: null, expiresAt: { $gt: new Date() } })
          .sort({ createdAt: -1 })
          .lean()
      : null;
    res.set('Cache-Control', 'no-store');
    return res.json({
      success: true,
      runtime,
      userId,
      features: { label: RUNTIME_FEATURES[runtime].label, pairing: RUNTIME_FEATURES[runtime].pairing, ssh: RUNTIME_FEATURES[runtime].ssh, sso: Boolean(RUNTIME_FEATURES[runtime].sso) },
      commands: buildCommands({ runtime, userId, ssh }),
    });
  } catch (err) {
    return sendError(res, err, next);
  }
});

router.post('/:runtime/pairing/approve', userOrCommandToken('pairing.approve'), async (req, res, next) => {
  try {
    const runtime = String(req.params.runtime).toLowerCase();
    if (!RUNTIME_FEATURES[runtime].pairing) {
      return res.json({ success: true, skipped: true, message: `${RUNTIME_FEATURES[runtime].label} does not use device pairing.` });
    }
    await assertActiveSubscription(req.user, runtime);
    const result = await approveOwnPairing({
      userId: String(req.user._id),
      requestId: req.body?.requestId || req.body?.request_id,
    });
    return res.json({ success: true, message: 'Device approved.', ...result });
  } catch (err) {
    return sendError(res, err, next);
  }
});

router.post('/:runtime/launch', userOrCommandToken('launch'), async (req, res, next) => {
  try {
    const runtime = String(req.params.runtime).toLowerCase();
    const sso = RUNTIME_FEATURES[runtime].sso;
    if (!sso) {
      return res.status(400).json({ success: false, message: 'Open this agent from your aimarkets.vn dashboard.' });
    }
    await assertActiveSubscription(req.user, runtime);
    const userId = String(req.user._id).toLowerCase();
    const base = applyTemplate(process.env[`${sso.envPrefix}_AIMARKETS_PUBLIC_URL_TEMPLATE`] || sso.template, userId);
    const ticket = issueRuntimeTicket({ runtime, envPrefix: sso.envPrefix, user: req.user });
    const url = buildSsoLaunchUrl({ base, ssoPath: process.env[`${sso.envPrefix}_AIMARKETS_SSO_PATH`] || sso.path, ticket });
    if (!url) return res.status(503).json({ success: false, message: `${RUNTIME_FEATURES[runtime].label} SSO is not configured.` });
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, url, expiresInSeconds: 120 });
  } catch (err) {
    return sendError(res, err, next);
  }
});

module.exports = router;
module.exports.buildCommands = buildCommands;
module.exports.RUNTIME_FEATURES = RUNTIME_FEATURES;
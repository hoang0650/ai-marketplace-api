const express = require('express');
const { authenticate } = require('../middleware/auth');
const { issueRuntimeTicket } = require('../utils/runtime-sso-ticket');
const { assertActiveSubscription } = require('../finance/agent-subscription');

const USER_ID_RE = /^[a-f0-9]{24}$/i;

function applyTemplate(template, userId) {
  const id = String(userId || '').trim().toLowerCase();
  if (!USER_ID_RE.test(id)) return '';
  return String(template)
    .replace(/\{userId\}/gi, id)
    .replace(/\{tenant\}/gi, id)
    .replace(/^http:\/\//i, 'https://')
    .replace(/\/$/, '');
}

/**
 * Launch URL for a runtime whose fork exposes an AI Markets SSO endpoint:
 * `https://{userId}.<host>/<ssoPath>?ticket=<2-minute HMAC ticket>`.
 * The endpoint verifies the ticket, finds/creates the buyer's own account and
 * sets the session cookie, so every buyer only sees their own workspace.
 */
function buildSsoLaunchUrl({ base, ssoPath, ticket }) {
  if (!base || !ticket) return null;
  const path = `/${String(ssoPath || '').replace(/^\/+/, '')}`;
  return `${base}${path}?${new URLSearchParams({ ticket }).toString()}`;
}

/**
 * @param {{ runtime: string, label: string, envPrefix: string, defaultTemplate: string, defaultSsoPath: string }} opts
 */
function createRuntimeSsoRouter({ runtime, label, envPrefix, defaultTemplate, defaultSsoPath }) {
  const router = express.Router();

  const publicTemplate = () =>
    process.env[`${envPrefix}_AIMARKETS_PUBLIC_URL_TEMPLATE`] || defaultTemplate;
  const ssoPath = () => process.env[`${envPrefix}_AIMARKETS_SSO_PATH`] || defaultSsoPath;

  router.post('/launch', authenticate, async (req, res, next) => {
    try {
      const userId = String(req.user?._id || req.user?.id || '').trim().toLowerCase();
      if (!USER_ID_RE.test(userId)) {
        return res.status(400).json({
          success: false,
          message: `${label} AI Markets needs a signed-in marketplace user id.`,
        });
      }
      await assertActiveSubscription(req.user, runtime);

      const base = applyTemplate(publicTemplate(), userId);
      const ticket = issueRuntimeTicket({ runtime, envPrefix, user: req.user });
      const url = buildSsoLaunchUrl({ base, ssoPath: ssoPath(), ticket });
      if (!url) {
        return res.status(503).json({
          success: false,
          message: `${label} AI Markets is not configured. Set ${envPrefix}_SSO_SECRET (same value on the ${label} service) and ${envPrefix}_AIMARKETS_PUBLIC_URL_TEMPLATE.`,
        });
      }

      return res.json({
        success: true,
        url,
        audience: 'aimarkets',
        userId,
        autoLogin: true,
        edge: 'proxvn',
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/device-pairings/approve', authenticate, async (_req, res) => {
    return res.json({
      success: true,
      skipped: true,
      message: `${label} has no device pairing — the launch URL signs the buyer in.`,
    });
  });

  return router;
}

module.exports = { createRuntimeSsoRouter, buildSsoLaunchUrl, applyTemplate };

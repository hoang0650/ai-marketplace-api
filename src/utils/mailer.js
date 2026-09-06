const { Resend } = require('resend');
const config = require('../config/env');

let client = null;

function getResend() {
  if (!config.resendApiKey) return null;
  if (!client) client = new Resend(config.resendApiKey);
  return client;
}

function isEmailReady() {
  return !!(config.resendApiKey && config.emailFrom && !config.skipEmail);
}

/**
 * Transactional send via Resend. Never throws to the caller — checkout must not fail
 * because mail delivery failed.
 */
async function sendResendEmail({ to, subject, html, text, tags = [] }) {
  if (config.skipEmail) {
    return { skipped: true, reason: 'SKIP_EMAIL' };
  }
  const resend = getResend();
  if (!resend) {
    console.warn('[mail] Resend skipped: RESEND_API_KEY is not set');
    return { skipped: true, reason: 'NO_API_KEY' };
  }
  const recipient = String(to || '')
    .trim()
    .toLowerCase();
  if (!recipient || !recipient.includes('@')) {
    console.warn('[mail] Resend skipped: invalid recipient');
    return { skipped: true, reason: 'INVALID_TO' };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: config.emailFrom,
      to: [recipient],
      replyTo: config.emailReplyTo || undefined,
      subject,
      html,
      text,
      tags: tags.length ? tags : [{ name: 'category', value: 'checkout' }],
    });

    if (error) {
      const message = error.message || String(error);
      console.error('[mail] Resend error:', message);
      return { ok: false, error: message };
    }

    return { ok: true, id: data?.id, provider: 'resend' };
  } catch (err) {
    const message = err?.message || String(err);
    console.error('[mail] Resend threw:', message);
    return { ok: false, error: message };
  }
}

module.exports = { sendResendEmail, isEmailReady };

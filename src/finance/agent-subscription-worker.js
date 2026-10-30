const AgentSubscription = require('../models/AgentSubscription');
const { runtimeAvailability } = require('../utils/agent-runtime-availability');
const User = require('../models/User');
const SshSession = require('../models/SshSession');
const HermesAccount = require('../models/HermesAccount');
const HiredAgent = require('../models/HiredAgent');
const config = require('../config/env');
const { notifyUser, notifyMany, buildNotification } = require('../utils/notify');
const { sendResendEmail, isEmailReady } = require('../utils/mailer');
const { ssoSecret } = require('../utils/runtime-sso-ticket');
const { expectedServiceSecret } = require('../utils/service-secret');
const { isAdmin } = require('../utils/roles');
const {
  AGENT_LABELS,
  DAY_MS,
  monthlyFee,
  normalizeAgentId,
  retentionDays,
  subscribeAgent,
} = require('./agent-subscription');

const HOUR_MS = 60 * 60 * 1000;

const ENV_PREFIX = {
  openclaw: 'OPENCLAW',
  hermes: 'HERMES',
  spacebot: 'SPACEBOT',
  nanoclaw: 'NANOCLAW',
  openwebui: 'OPENWEBUI',
  paperclip: 'PAPERCLIP',
};

/** Marketplace route ids on web/app (`/hire-agent/:id`). */
const WEB_IDS = { nanoclaw: 'nano-claw', openwebui: 'open-webui', spacebot: 'space-bot' };

function envNumber(name, fallback, min) {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw >= min ? raw : fallback;
}

function workerConfig() {
  return {
    tickMs: envNumber('AGENT_SUBSCRIPTION_TICK_MS', 15 * 60 * 1000, 60 * 1000),
    remindDays: envNumber('AGENT_RENEW_REMIND_DAYS', 3, 0),
    renewLeadHours: envNumber('AGENT_RENEW_LEAD_HOURS', 24, 0),
    retryHours: envNumber('AGENT_RENEW_RETRY_HOURS', 6, 1),
  };
}

const fmtDate = (d) => new Date(d).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
const fmtVnd = (vnd) => `${Math.round(vnd || 0).toLocaleString('vi-VN')} đ`;
const sameTime = (a, b) => Boolean(a && b && new Date(a).getTime() === new Date(b).getTime());

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** In-app notification, plus an email for billing-relevant events when Resend is configured. */
async function notifyBuyer(user, agentId, key, params, { email = false } = {}) {
  const href = `/hire-agent/${WEB_IDS[agentId] || agentId}`;
  await notifyUser(user._id, key, params, href);
  if (!email || !user.email || !isEmailReady()) return;
  const { title, body } = buildNotification(key, params);
  const url = `${config.frontendUrl.replace(/\/$/, '')}${href}`;
  await sendResendEmail({
    to: user.email,
    subject: `AI Markets – ${title}`,
    text: `${body}\n\n${url}`,
    html: `<p>${escapeHtml(body)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
    tags: [{ name: 'category', value: 'agent_subscription' }],
  });
}

async function revokeAgentSsh(userId, agentId, now) {
  const rows = await SshSession.find({ user: userId, revokedAt: null }).select('agentId').lean();
  const ids = rows.filter((r) => normalizeAgentId(r.agentId) === agentId).map((r) => r._id);
  if (ids.length) await SshSession.updateMany({ _id: { $in: ids } }, { $set: { revokedAt: now } });
}

function purgeUrl(agentId, userId) {
  const template = String(process.env[`${ENV_PREFIX[agentId]}_AIMARKETS_PURGE_URL`] || '').trim();
  if (!template) return '';
  const url = template.replace(/\{userId\}/gi, String(userId).toLowerCase()).replace(/\{tenant\}/gi, String(userId).toLowerCase());
  return /^https:\/\//i.test(url) ? url : '';
}

function purgeWebhookConfigured(agentId) {
  const sample = '000000000000000000000000';
  return Boolean(purgeUrl(agentId, sample) && (ssoSecret(ENV_PREFIX[agentId]) || expectedServiceSecret()));
}

/**
 * Delete one buyer's workspace for an agent: API-side access (SSH, Hermes
 * credentials, My Agents row) always; runtime data through the runtime's
 * purge webhook. Without a webhook the purge is queued for an operator.
 * @returns {Promise<{ status: 'done'|'manual_required'|'failed', error?: string }>}
 */
async function purgeAgentData(doc, now = new Date()) {
  const agentId = doc.agentId;
  const userId = String(doc.user);
  await revokeAgentSsh(doc.user, agentId, now);
  if (agentId === 'hermes') await HermesAccount.deleteOne({ user: doc.user });
  const hired = await HiredAgent.find({ user: doc.user }).select('agentId').lean();
  const hiredIds = hired.filter((h) => normalizeAgentId(h.agentId) === agentId).map((h) => h._id);
  if (hiredIds.length) {
    await HiredAgent.updateMany({ _id: { $in: hiredIds } }, { $set: { status: 'archived', archivedAt: now } });
  }

  const url = purgeUrl(agentId, userId);
  const secret = ssoSecret(ENV_PREFIX[agentId]) || expectedServiceSecret();
  if (!url || !secret) return { status: 'manual_required' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Runtime-Secret': secret },
      body: JSON.stringify({ userId, agentId, reason: 'subscription_expired' }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return { status: 'done' };
    console.warn('[agent-subscription] purge webhook', agentId, userId, res.status);
    return { status: 'failed', error: `Webhook HTTP ${res.status}` };
  } catch (err) {
    console.warn('[agent-subscription] purge webhook', agentId, userId, err.message);
    return { status: 'failed', error: String(err.message || err).slice(0, 300) };
  }
}

async function markPurged(doc, user, now, { by = null, note = '' } = {}) {
  await AgentSubscription.updateOne(
    { _id: doc._id },
    { $set: { purgedAt: now, purgeStatus: 'done', purgeError: '', purgedBy: by, purgeNote: String(note || '').slice(0, 500) } },
  );
  if (user) {
    await notifyBuyer(user, doc.agentId, 'agent.purged', {
      brand: AGENT_LABELS[doc.agentId],
      days: retentionDays(),
    });
  }
}

/**
 * One subscription through the lifecycle:
 * auto-renew → reminder → expiry (lock + SSH revoke) → purge after retention.
 */
async function processSubscription(doc, now = new Date(), cfg = workerConfig()) {
  const agentId = doc.agentId;
  // Do not bill, expire or purge a buyer's workspace during operator maintenance.
  if (!runtimeAvailability(agentId).available) return 'maintenance';
  const fee = monthlyFee(agentId);
  if (fee.amount <= 0 || doc.purgedAt) return 'skip';
  const user = await User.findById(doc.user).select('role email name').lean();
  if (!user || isAdmin(user)) return 'skip';

  const t = now.getTime();
  const paidUntil = new Date(doc.paidUntil);
  const base = { brand: AGENT_LABELS[agentId], price: fmtVnd(fee.vnd) };

  const renewDue = paidUntil.getTime() <= t + cfg.renewLeadHours * HOUR_MS;
  const retryOk = !doc.lastRenewAttemptAt || new Date(doc.lastRenewAttemptAt).getTime() <= t - cfg.retryHours * HOUR_MS;
  // Never auto-renew a plan whose latest charge was refunded (failed launch / support refund).
  const refunded = Boolean(
    doc.lastRefundedAt && (!doc.lastChargedAt || new Date(doc.lastRefundedAt).getTime() >= new Date(doc.lastChargedAt).getTime()),
  );
  if (doc.autoRenew !== false && !refunded && renewDue && retryOk) {
    const claimed = await AgentSubscription.findOneAndUpdate(
      { _id: doc._id, paidUntil: doc.paidUntil, lastRenewAttemptAt: doc.lastRenewAttemptAt ?? null },
      { $set: { lastRenewAttemptAt: now } },
      { new: true },
    ).lean();
    if (claimed) {
      try {
        const res = await subscribeAgent(user, agentId, { now, source: 'auto' });
        await notifyBuyer(user, agentId, 'agent.renewed', { ...base, date: fmtDate(res.paidUntil) }, { email: true });
        return 'renewed';
      } catch (err) {
        if (err.status !== 402) throw err;
        if (!sameTime(doc.renewFailedFor, doc.paidUntil)) {
          // The failure notice doubles as this period's reminder.
          await AgentSubscription.updateOne(
            { _id: doc._id },
            { $set: { renewFailedFor: doc.paidUntil, reminderFor: doc.paidUntil } },
          );
          await notifyBuyer(user, agentId, 'agent.renewFailed', { ...base, date: fmtDate(paidUntil) }, { email: true });
          return 'renew_failed';
        }
      }
    }
  }

  if (paidUntil.getTime() > t) {
    const remindAt = paidUntil.getTime() - cfg.remindDays * DAY_MS;
    if (cfg.remindDays > 0 && t >= remindAt && !sameTime(doc.reminderFor, doc.paidUntil)) {
      await AgentSubscription.updateOne({ _id: doc._id }, { $set: { reminderFor: doc.paidUntil } });
      const key = doc.autoRenew !== false ? 'agent.renewSoon' : 'agent.expiringSoon';
      await notifyBuyer(user, agentId, key, { ...base, date: fmtDate(paidUntil) }, { email: true });
      return 'reminded';
    }
    return 'ok';
  }

  if (!sameTime(doc.expiredFor, doc.paidUntil)) {
    const purgeDueAt = new Date(paidUntil.getTime() + retentionDays() * DAY_MS);
    await AgentSubscription.updateOne({ _id: doc._id }, { $set: { expiredFor: doc.paidUntil, purgeDueAt } });
    await revokeAgentSsh(doc.user, agentId, now);
    await notifyBuyer(user, agentId, 'agent.expired', { ...base, purgeDate: fmtDate(purgeDueAt) }, { email: true });
    return 'expired';
  }

  const purgeDue = doc.purgeDueAt && new Date(doc.purgeDueAt).getTime() <= t;
  if (purgeDue && (!doc.purgeStatus || doc.purgeStatus === 'failed')) {
    const result = await executePurge(doc, user, now, { notifyAdmins: !doc.purgeStatus });
    return result === 'done' ? 'purged' : `purge_${result}`;
  }
  return 'ok';
}

/**
 * Run the purge and record the outcome (worker tick or admin retry).
 * @returns {Promise<'done'|'manual_required'|'failed'>}
 */
async function executePurge(doc, user, now = new Date(), { notifyAdmins = true } = {}) {
  const { status, error } = await purgeAgentData(doc, now);
  if (status === 'done') {
    await markPurged(doc, user, now);
    return status;
  }
  await AgentSubscription.updateOne(
    { _id: doc._id },
    { $set: { purgeStatus: status, purgeAttemptedAt: now, purgeError: error || '' } },
  );
  if (status === 'manual_required' && notifyAdmins) {
    const admins = await User.find({ role: 'admin' }).select('_id').lean();
    await notifyMany(
      admins.map((a) => a._id),
      'agent.purgeManual',
      { brand: AGENT_LABELS[doc.agentId], userId: String(doc.user) },
      '/admin/agent-purges',
    );
  }
  return status;
}

async function runAgentSubscriptionTick(now = new Date()) {
  const cfg = workerConfig();
  const horizon = new Date(now.getTime() + Math.max(cfg.remindDays * DAY_MS, cfg.renewLeadHours * HOUR_MS));
  const rows = await AgentSubscription.find({ purgedAt: null, paidUntil: { $lte: horizon } }).lean();
  const out = { total: rows.length, renewed: 0, reminded: 0, expired: 0, purged: 0, manual: 0, errors: 0 };
  for (const doc of rows) {
    try {
      const r = await processSubscription(doc, now, cfg);
      if (r === 'renewed') out.renewed += 1;
      if (r === 'reminded') out.reminded += 1;
      if (r === 'expired') out.expired += 1;
      if (r === 'purged') out.purged += 1;
      if (r === 'purge_manual_required') out.manual += 1;
    } catch (err) {
      out.errors += 1;
      console.error('[agent-subscription] tick failed', String(doc._id), err.code || err.message);
    }
  }
  return out;
}

let timer = null;
let busy = false;

function startAgentSubscriptionWorker() {
  if (timer) return timer;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await runAgentSubscriptionTick();
      if (r.renewed || r.expired || r.purged || r.manual || r.errors) {
        console.log('[agent-subscription] tick', JSON.stringify(r));
      }
    } catch (err) {
      console.error('[agent-subscription] tick error', err.message);
    } finally {
      busy = false;
    }
  };
  timer = setInterval(tick, workerConfig().tickMs);
  timer.unref?.();
  return timer;
}

function stopAgentSubscriptionWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  ENV_PREFIX,
  workerConfig,
  processSubscription,
  purgeAgentData,
  purgeWebhookConfigured,
  executePurge,
  markPurged,
  runAgentSubscriptionTick,
  startAgentSubscriptionWorker,
  stopAgentSubscriptionWorker,
};

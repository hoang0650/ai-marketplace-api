const AgentSubscription = require('../models/AgentSubscription');
const User = require('../models/User');
const WalletTx = require('../models/WalletTx');
const LedgerEntry = require('../models/LedgerEntry');
const { requireAvailableFunds } = require('../utils/wallet');
const { newEntryId } = require('./ledger-service');
const { vndToUsd } = require('./payout-policy');
const { isAdmin } = require('../utils/roles');

/**
 * Platform-hosted agents are rented per month (prepaid from the wallet).
 * Token usage is billed on top per call only when the buyer runs a platform
 * model (provider cost + markup); BYOK runs carry no token charge.
 */
const AGENT_IDS = ['openclaw', 'hermes', 'spacebot', 'nanoclaw', 'openwebui', 'paperclip'];

/** Runtimes that only run on the buyer's own provider keys (no platform-model token billing). */
const BYOK_ONLY_AGENTS = ['openwebui', 'paperclip'];

const AGENT_LABELS = {
  openclaw: 'OpenClaw',
  hermes: 'Hermes Agent',
  spacebot: 'SpaceBot',
  nanoclaw: 'NanoClaw',
  openwebui: 'Open WebUI',
  paperclip: 'Paperclip',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Accepts marketplace slugs (`nano-claw`, `open-webui`, `hermes-agent`) and runtime ids. */
function normalizeAgentId(raw) {
  const id = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (id === 'hermesagent') return 'hermes';
  return AGENT_IDS.includes(id) ? id : '';
}

function periodDays() {
  const raw = Number(process.env.AGENT_SUBSCRIPTION_DAYS ?? 30);
  return Number.isFinite(raw) && raw >= 1 ? Math.round(raw) : 30;
}

function monthlyFee(agentId) {
  const id = normalizeAgentId(agentId);
  const perAgent = id ? process.env[`AGENT_MONTHLY_FEE_VND_${id.toUpperCase()}`] : undefined;
  const raw = Number(perAgent ?? process.env.AGENT_MONTHLY_FEE_VND ?? 199000);
  const vnd = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
  return { vnd, amount: vndToUsd(vnd), currency: 'USD', periodDays: periodDays() };
}

/** Days the workspace data is kept after a plan expires before it is deleted. */
function retentionDays() {
  const raw = Number(process.env.AGENT_DATA_RETENTION_DAYS ?? 30);
  return Number.isFinite(raw) && raw >= 1 ? Math.round(raw) : 30;
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

function describe(agentId, doc, { exempt = false, now = new Date() } = {}) {
  const fee = monthlyFee(agentId);
  const paidUntil = doc?.paidUntil ? new Date(doc.paidUntil) : null;
  const active = exempt || fee.amount <= 0 || Boolean(paidUntil && paidUntil.getTime() > now.getTime());
  return {
    agentId,
    active,
    exempt: exempt || fee.amount <= 0,
    paidUntil: iso(paidUntil),
    daysLeft: paidUntil ? Math.max(0, Math.ceil((paidUntil.getTime() - now.getTime()) / DAY_MS)) : 0,
    autoRenew: doc ? doc.autoRenew !== false : true,
    purgeDueAt: iso(doc?.purgeDueAt),
    purgedAt: iso(doc?.purgedAt),
    retentionDays: retentionDays(),
    fee,
  };
}

async function getSubscriptionStatus(user, agentId) {
  const id = normalizeAgentId(agentId);
  if (!id) return null;
  const doc = await AgentSubscription.findOne({ user: user._id, agentId: id }).lean();
  return describe(id, doc, { exempt: isAdmin(user) });
}

async function listSubscriptions(user) {
  const docs = await AgentSubscription.find({ user: user._id }).lean();
  const byId = new Map(docs.map((d) => [d.agentId, d]));
  return AGENT_IDS.map((id) => describe(id, byId.get(id), { exempt: isAdmin(user) }));
}

function subscriptionRequiredError(status) {
  const label = AGENT_LABELS[status.agentId] || status.agentId;
  const err = new Error(
    status.paidUntil
      ? `${label} subscription expired on ${status.paidUntil.slice(0, 10)}. Renew the monthly plan to keep using this agent.`
      : `${label} requires a monthly subscription (${status.fee.vnd.toLocaleString('vi-VN')} VND / ${status.fee.periodDays} days).`,
  );
  err.status = 402;
  err.code = 'AGENT_SUBSCRIPTION_REQUIRED';
  err.body = status;
  return err;
}

/** Throws 402 AGENT_SUBSCRIPTION_REQUIRED unless the user has an active plan (admins are exempt). */
async function assertActiveSubscription(user, agentId) {
  const status = await getSubscriptionStatus(user, agentId);
  if (!status || status.active) return status;
  throw subscriptionRequiredError(status);
}

/** Gateway-plugin path: only a user id is known (service secret auth). */
async function hasActiveSubscriptionByUserId(userId, agentId) {
  const id = normalizeAgentId(agentId);
  if (!id) return true;
  const [user, doc] = await Promise.all([
    User.findById(userId).select('role').lean(),
    AgentSubscription.findOne({ user: userId, agentId: id }).lean(),
  ]);
  return describe(id, doc, { exempt: isAdmin(user) }).active;
}

/**
 * Charge one period from the wallet and extend `paidUntil` by `periodDays`
 * from max(now, current paidUntil) — renewing early never loses paid days.
 */
async function subscribeAgent(user, agentId, { now = new Date(), source = 'manual' } = {}) {
  const id = normalizeAgentId(agentId);
  if (!id) {
    const err = new Error('Unknown agent');
    err.status = 400;
    throw err;
  }
  const fee = monthlyFee(id);
  if (isAdmin(user) || fee.amount <= 0) {
    return { ...(await getSubscriptionStatus(user, id)), charged: false };
  }

  await requireAvailableFunds(user._id, fee.amount, { currency: fee.currency });

  const label = AGENT_LABELS[id];
  const meta = { kind: 'agent_subscription', agentId: id, feeVnd: fee.vnd, periodDays: fee.periodDays, source };
  await WalletTx.create({
    user: user._id,
    type: 'debit',
    amount: fee.amount,
    currency: fee.currency,
    note: `${source === 'auto' ? 'Tự động gia hạn' : 'Phí thuê'} agent ${label} (${fee.periodDays} ngày)`,
    meta,
  });

  const doc = await AgentSubscription.findOneAndUpdate(
    { user: user._id, agentId: id },
    [
      {
        $set: {
          paidUntil: { $add: [{ $max: ['$paidUntil', now] }, fee.periodDays * DAY_MS] },
          startedAt: { $ifNull: ['$startedAt', now] },
          periods: { $add: [{ $ifNull: ['$periods', 0] }, 1] },
          autoRenew: { $ifNull: ['$autoRenew', true] },
          lastChargedAt: now,
          lastFeeVnd: fee.vnd,
          lastAmount: fee.amount,
          currency: fee.currency,
          renewFailedFor: null,
          lastRenewAttemptAt: null,
          purgeDueAt: null,
          purgedAt: null,
          purgeStatus: '',
        },
      },
    ],
    { upsert: true, new: true },
  ).lean();

  await LedgerEntry.create({
    entryId: newEntryId('agsub'),
    buyerId: user._id,
    type: 'PLATFORM_REVENUE',
    amount: fee.amount,
    currency: fee.currency,
    direction: 'credit',
    ownershipType: 'PLATFORM_DIRECT',
    reference: `agent:${id}:subscription:${doc?._id || ''}`,
    meta: { ...meta, paidUntil: doc?.paidUntil },
  }).catch((err) => console.error('[ledger] agent subscription', err.message));

  return { ...describe(id, doc, { now }), charged: true };
}

/** Turn wallet auto-renewal on/off for one agent plan. */
async function setAutoRenew(user, agentId, autoRenew) {
  const id = normalizeAgentId(agentId);
  if (!id) return null;
  const doc = await AgentSubscription.findOneAndUpdate(
    { user: user._id, agentId: id },
    { $set: { autoRenew: Boolean(autoRenew) } },
    { new: true },
  ).lean();
  if (!doc) {
    const err = new Error('No plan for this agent yet — rent it first.');
    err.status = 404;
    throw err;
  }
  return describe(id, doc, { exempt: isAdmin(user) });
}

module.exports = {
  AGENT_IDS,
  AGENT_LABELS,
  BYOK_ONLY_AGENTS,
  DAY_MS,
  normalizeAgentId,
  monthlyFee,
  retentionDays,
  describe,
  setAutoRenew,
  getSubscriptionStatus,
  listSubscriptions,
  assertActiveSubscription,
  hasActiveSubscriptionByUserId,
  subscribeAgent,
};

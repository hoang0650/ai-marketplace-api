const AgentSubscription = require('../models/AgentSubscription');
const User = require('../models/User');
const WalletTx = require('../models/WalletTx');
const LedgerEntry = require('../models/LedgerEntry');
const { requireAvailableFunds } = require('../utils/wallet');
const { newEntryId } = require('./ledger-service');
const { vndToUsd } = require('./payout-policy');
const { isAdmin } = require('../utils/roles');
const { notifyUser } = require('../utils/notify');
const { assertRuntimeAvailable } = require('../utils/agent-runtime-availability');

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

/** A second manual charge for the same agent inside this window is treated as a double click. */
const DUPLICATE_WINDOW_MS = 20 * 1000;
/** Failed-provisioning refunds are only accepted this long after the charge. */
const REFUND_WINDOW_MS = 30 * 60 * 1000;

/** Per-process lock so two concurrent requests for the same user+agent can never both charge. */
const chargeLocks = new Set();

function cleanIdempotencyKey(raw) {
  const key = String(raw || '').trim().slice(0, 80);
  return /^[A-Za-z0-9._:-]{8,80}$/.test(key) ? key : '';
}

function vndText(vnd) {
  return `${Math.round(vnd || 0).toLocaleString('vi-VN')} ₫`;
}

function chargeSummary(tx, fee) {
  return {
    walletTxId: tx?._id ? String(tx._id) : null,
    chargedAmount: tx?.amount ?? fee.amount,
    chargedVnd: tx?.meta?.feeVnd ?? fee.vnd,
    chargedCurrency: tx?.currency || fee.currency,
    chargedAt: iso(tx?.createdAt) || null,
  };
}

/**
 * Charge one period from the wallet and extend `paidUntil` by `periodDays`
 * from max(now, current paidUntil) — renewing early never loses paid days.
 *
 * Manual rentals are idempotent: the same `idempotencyKey` (one per Launch click)
 * returns the original charge instead of charging again, and a second manual
 * charge for the same agent within DUPLICATE_WINDOW_MS is refused with 409.
 */
async function subscribeAgent(user, agentId, { now = new Date(), source = 'manual', idempotencyKey } = {}) {
  const id = normalizeAgentId(agentId);
  if (!id) {
    const err = new Error('Unknown agent');
    err.status = 400;
    throw err;
  }
  assertRuntimeAvailable(id);
  const fee = monthlyFee(id);
  if (isAdmin(user) || fee.amount <= 0) {
    return { ...(await getSubscriptionStatus(user, id)), charged: false };
  }

  const key = source === 'manual' ? cleanIdempotencyKey(idempotencyKey) : '';
  const lockKey = `${user._id}:${id}`;
  if (source === 'manual') {
    if (chargeLocks.has(lockKey)) {
      const err = new Error('This rental is already being processed — please wait a moment.');
      err.status = 409;
      err.code = 'RENTAL_IN_PROGRESS';
      throw err;
    }
    chargeLocks.add(lockKey);
  }
  try {
    if (source === 'manual') {
      const recent = await WalletTx.findOne({
        user: user._id,
        type: 'debit',
        'meta.kind': 'agent_subscription',
        'meta.agentId': id,
        'meta.source': 'manual',
        ...(key ? {} : { createdAt: { $gte: new Date(now.getTime() - DUPLICATE_WINDOW_MS) } }),
        ...(key ? { 'meta.idempotencyKey': key } : {}),
      })
        .sort({ createdAt: -1 })
        .lean();
      if (recent && key) {
        const doc = await AgentSubscription.findOne({ user: user._id, agentId: id }).lean();
        return { ...describe(id, doc, { now }), charged: false, duplicate: true, ...chargeSummary(recent, fee) };
      }
      if (recent) {
        const err = new Error('This agent was just rented — refresh to see your plan instead of paying twice.');
        err.status = 409;
        err.code = 'RENTAL_DUPLICATE';
        throw err;
      }
      if (key) {
        // Different key but a charge landed seconds ago: still a double submit.
        const fresh = await WalletTx.findOne({
          user: user._id,
          type: 'debit',
          'meta.kind': 'agent_subscription',
          'meta.agentId': id,
          'meta.source': 'manual',
          createdAt: { $gte: new Date(now.getTime() - DUPLICATE_WINDOW_MS) },
        }).lean();
        if (fresh) {
          const err = new Error('This agent was just rented — refresh to see your plan instead of paying twice.');
          err.status = 409;
          err.code = 'RENTAL_DUPLICATE';
          throw err;
        }
      }
    }

    await requireAvailableFunds(user._id, fee.amount, { currency: fee.currency });

    const label = AGENT_LABELS[id];
    const meta = { kind: 'agent_subscription', agentId: id, feeVnd: fee.vnd, periodDays: fee.periodDays, source };
    if (key) meta.idempotencyKey = key;
    const tx = await WalletTx.create({
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
            // A new manual rental after a refund starts with the default (auto-renew on) again.
            autoRenew:
              source === 'manual'
                ? { $cond: [{ $ne: [{ $ifNull: ['$lastRefundedAt', null] }, null] }, true, { $ifNull: ['$autoRenew', true] }] }
                : { $ifNull: ['$autoRenew', true] },
            lastRefundedAt: source === 'manual' ? null : { $ifNull: ['$lastRefundedAt', null] },
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

    if (source === 'manual') {
      await notifyUser(
        user._id,
        'agent.rented',
        { brand: label, price: vndText(fee.vnd), days: fee.periodDays, date: iso(doc?.paidUntil)?.slice(0, 10) },
        `/hire-agent/${id}`,
      ).catch((err) => console.error('[notify] agent rented', err.message));
    }

    return { ...describe(id, doc, { now }), charged: true, ...chargeSummary({ _id: tx?._id, amount: fee.amount, currency: fee.currency, meta, createdAt: tx?.createdAt || now }, fee) };
  } finally {
    if (source === 'manual') chargeLocks.delete(lockKey);
  }
}

/**
 * Refund a manual rental whose workspace could not be provisioned/launched.
 * Only the buyer's own charge, only once, only within REFUND_WINDOW_MS; the
 * paid period is removed from `paidUntil` again.
 */
async function refundFailedRental(user, agentId, walletTxId, { now = new Date(), reason = '' } = {}) {
  const id = normalizeAgentId(agentId);
  if (!id || !walletTxId || !/^[a-f0-9]{24}$/i.test(String(walletTxId))) {
    const err = new Error('Unknown rental');
    err.status = 400;
    throw err;
  }
  const tx = await WalletTx.findOne({
    _id: walletTxId,
    user: user._id,
    type: 'debit',
    'meta.kind': 'agent_subscription',
    'meta.agentId': id,
    'meta.source': 'manual',
  }).lean();
  if (!tx) {
    const err = new Error('Rental charge not found');
    err.status = 404;
    throw err;
  }
  if (tx.meta?.refundedAt) {
    return { refunded: false, alreadyRefunded: true, amount: tx.amount, currency: tx.currency, feeVnd: tx.meta.feeVnd };
  }
  if (now.getTime() - new Date(tx.createdAt).getTime() > REFUND_WINDOW_MS) {
    const err = new Error('The automatic refund window has passed — please contact support.');
    err.status = 409;
    err.code = 'REFUND_WINDOW_PASSED';
    throw err;
  }
  // Claim the refund atomically so two calls can never both credit.
  const claimed = await WalletTx.findOneAndUpdate(
    { _id: tx._id, 'meta.refundedAt': { $exists: false } },
    { $set: { 'meta.refundedAt': now, 'meta.refundReason': String(reason || '').slice(0, 200) } },
    { new: true },
  ).lean();
  if (!claimed) {
    return { refunded: false, alreadyRefunded: true, amount: tx.amount, currency: tx.currency, feeVnd: tx.meta?.feeVnd };
  }
  const label = AGENT_LABELS[id];
  const days = Number(tx.meta?.periodDays) || periodDays();
  const credit = await WalletTx.create({
    user: user._id,
    type: 'credit',
    amount: tx.amount,
    currency: tx.currency,
    note: `Hoàn phí thuê agent ${label} (khởi tạo thất bại)`,
    meta: { kind: 'agent_subscription_refund', agentId: id, refundOf: String(tx._id), feeVnd: tx.meta?.feeVnd },
  });
  const doc = await AgentSubscription.findOneAndUpdate(
    { user: user._id, agentId: id },
    [
      {
        $set: {
          paidUntil: { $subtract: ['$paidUntil', days * DAY_MS] },
          periods: { $max: [0, { $subtract: [{ $ifNull: ['$periods', 1] }, 1] }] },
          // A refunded period must never be re-charged by the auto-renew worker.
          autoRenew: false,
          lastRefundedAt: now,
        },
      },
    ],
    { new: true },
  ).lean();
  await LedgerEntry.create({
    entryId: newEntryId('agref'),
    buyerId: user._id,
    type: 'REFUND',
    amount: tx.amount,
    currency: tx.currency,
    direction: 'debit',
    ownershipType: 'PLATFORM_DIRECT',
    reference: `agent:${id}:subscription-refund:${tx._id}`,
    meta: { kind: 'agent_subscription_refund', agentId: id, refundOf: String(tx._id) },
  }).catch((err) => console.error('[ledger] agent refund', err.message));
  await notifyUser(user._id, 'agent.rentRefunded', { brand: label, price: vndText(tx.meta?.feeVnd) }, `/hire-agent/${id}`).catch(
    (err) => console.error('[notify] agent refund', err.message),
  );
  return {
    refunded: true,
    amount: tx.amount,
    currency: tx.currency,
    feeVnd: tx.meta?.feeVnd,
    refundTxId: credit?._id ? String(credit._id) : null,
    status: describe(id, doc, { now, exempt: isAdmin(user) }),
  };
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
  refundFailedRental,
  cleanIdempotencyKey,
};

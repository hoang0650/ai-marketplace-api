const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const WalletTx = require('../../src/models/WalletTx');
const LedgerEntry = require('../../src/models/LedgerEntry');
const Order = require('../../src/models/Order');
const UsageEvent = require('../../src/models/UsageEvent');
const User = require('../../src/models/User');
const AgentSubscription = require('../../src/models/AgentSubscription');
const {
  normalizeAgentId,
  monthlyFee,
  assertActiveSubscription,
  hasActiveSubscriptionByUserId,
  subscribeAgent,
  refundFailedRental,
} = require('../../src/finance/agent-subscription');
const { VND_PER_USD } = require('../../src/finance/payout-policy');

const DAY_MS = 24 * 60 * 60 * 1000;

function stubWallet(t, balance) {
  t.mock.method(WalletTx, 'aggregate', async () => [{ balance }]);
  t.mock.method(UsageEvent, 'aggregate', async () => []);
  t.mock.method(Order, 'find', () => ({ sort: () => ({ lean: async () => [] }) }));
}

function stubSubscription(t, doc) {
  t.mock.method(AgentSubscription, 'findOne', () => ({ lean: async () => doc }));
}

const buyer = () => ({ _id: new mongoose.Types.ObjectId(), role: 'buyer' });

test('marketplace slugs map to runtime ids', () => {
  assert.equal(normalizeAgentId('nano-claw'), 'nanoclaw');
  assert.equal(normalizeAgentId('open-webui'), 'openwebui');
  assert.equal(normalizeAgentId('hermes-agent'), 'hermes');
  assert.equal(normalizeAgentId('OpenClaw'), 'openclaw');
  assert.equal(normalizeAgentId('unknown'), '');
});

test('monthly fee defaults to 199,000 VND per 30 days, overridable per agent', (t) => {
  const fee = monthlyFee('openclaw');
  assert.equal(fee.vnd, 199000);
  assert.equal(fee.periodDays, 30);
  assert.equal(fee.amount, Math.round((199000 / VND_PER_USD) * 100) / 100);

  process.env.AGENT_MONTHLY_FEE_VND_HERMES = '99000';
  t.after(() => delete process.env.AGENT_MONTHLY_FEE_VND_HERMES);
  assert.equal(monthlyFee('hermes').vnd, 99000);
  assert.equal(monthlyFee('spacebot').vnd, 199000);
});

test('launch is refused without a subscription', async (t) => {
  stubSubscription(t, null);
  await assert.rejects(
    assertActiveSubscription(buyer(), 'openclaw'),
    (err) => err.status === 402 && err.code === 'AGENT_SUBSCRIPTION_REQUIRED',
  );
});

test('launch is refused after the paid period ends', async (t) => {
  stubSubscription(t, { paidUntil: new Date(Date.now() - DAY_MS) });
  await assert.rejects(assertActiveSubscription(buyer(), 'hermes'), (err) => err.code === 'AGENT_SUBSCRIPTION_REQUIRED');
});

test('launch is allowed while the plan is paid', async (t) => {
  stubSubscription(t, { paidUntil: new Date(Date.now() + 5 * DAY_MS) });
  const status = await assertActiveSubscription(buyer(), 'nano-claw');
  assert.equal(status.active, true);
  assert.equal(status.agentId, 'nanoclaw');
  assert.equal(status.daysLeft, 5);
});

test('admins are exempt', async (t) => {
  stubSubscription(t, null);
  const status = await assertActiveSubscription({ _id: new mongoose.Types.ObjectId(), role: 'admin' }, 'paperclip');
  assert.equal(status.active, true);
  assert.equal(status.exempt, true);
});

test('gateway check by user id follows the subscription', async (t) => {
  t.mock.method(User, 'findById', () => ({ select: () => ({ lean: async () => ({ role: 'buyer' }) }) }));
  stubSubscription(t, null);
  assert.equal(await hasActiveSubscriptionByUserId(new mongoose.Types.ObjectId().toString(), 'spacebot'), false);
});

test('subscribing without enough wallet balance is rejected with 402', async (t) => {
  stubWallet(t, 0);
  stubNoRecent(t);
  const update = t.mock.method(AgentSubscription, 'findOneAndUpdate', () => ({ lean: async () => null }));
  await assert.rejects(subscribeAgent(buyer(), 'openclaw'), (err) => err.status === 402 && err.code === 'INSUFFICIENT_WALLET');
  assert.equal(update.mock.callCount(), 0);
});

test('subscribing debits one month and books platform revenue', async (t) => {
  stubWallet(t, 50);
  stubNoRecent(t);
  t.mock.method(require('../../src/models/Notification'), 'create', async () => ({}));
  const now = new Date('2026-10-03T00:00:00Z');
  const created = [];
  t.mock.method(WalletTx, 'create', async (doc) => created.push(['wallet', doc]));
  t.mock.method(LedgerEntry, 'create', async (doc) => created.push(['ledger', doc]));
  const update = t.mock.method(AgentSubscription, 'findOneAndUpdate', () => ({
    lean: async () => ({ _id: 'sub1', paidUntil: new Date(now.getTime() + 30 * DAY_MS) }),
  }));

  const res = await subscribeAgent(buyer(), 'open-webui', { now });
  assert.equal(res.charged, true);
  assert.equal(res.active, true);
  assert.equal(res.agentId, 'openwebui');

  const [[k1, tx], [k2, led]] = created;
  assert.equal(k1, 'wallet');
  assert.equal(tx.type, 'debit');
  assert.equal(tx.amount, monthlyFee('openwebui').amount);
  assert.equal(tx.meta.kind, 'agent_subscription');
  assert.equal(k2, 'ledger');
  assert.equal(led.type, 'PLATFORM_REVENUE');
  assert.equal(led.ownershipType, 'PLATFORM_DIRECT');

  const [filter, pipeline] = update.mock.calls.at(-1).arguments;
  assert.equal(filter.agentId, 'openwebui');
  assert.deepEqual(pipeline[0].$set.paidUntil, { $add: [{ $max: ['$paidUntil', now] }, 30 * DAY_MS] });
});

test('admins subscribe without being charged', async (t) => {
  stubSubscription(t, null);
  const spy = t.mock.method(WalletTx, 'create', async () => ({}));
  const res = await subscribeAgent({ _id: new mongoose.Types.ObjectId(), role: 'admin' }, 'openclaw');
  assert.equal(res.charged, false);
  assert.equal(spy.mock.callCount(), 0);
});

function stubNoRecent(t, recent = null) {
  return t.mock.method(WalletTx, 'findOne', () => {
    const q = { sort: () => q, lean: async () => recent };
    return q;
  });
}

test('subscribing books a no-op recent check and returns the charge summary + notification', async (t) => {
  stubWallet(t, 50);
  stubNoRecent(t);
  const Notification = require('../../src/models/Notification');
  const notes = [];
  t.mock.method(Notification, 'create', async (doc) => notes.push(doc));
  const now = new Date('2026-10-03T00:00:00Z');
  t.mock.method(WalletTx, 'create', async (doc) => ({ ...doc, _id: new mongoose.Types.ObjectId(), createdAt: now }));
  t.mock.method(LedgerEntry, 'create', async () => ({}));
  t.mock.method(AgentSubscription, 'findOneAndUpdate', () => ({
    lean: async () => ({ _id: 'sub1', paidUntil: new Date(now.getTime() + 30 * DAY_MS) }),
  }));
  const res = await subscribeAgent(buyer(), 'hermes', { now, idempotencyKey: 'click-12345678' });
  assert.equal(res.charged, true);
  assert.equal(res.chargedVnd, monthlyFee('hermes').vnd);
  assert.match(res.walletTxId, /^[a-f0-9]{24}$/);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].key, 'agent.rented');
  assert.equal(notes[0].href, '/hire-agent/hermes');
});

test('replaying the same idempotency key does not charge twice', async (t) => {
  stubWallet(t, 50);
  const prior = { _id: new mongoose.Types.ObjectId(), amount: 7.5, currency: 'USD', meta: { feeVnd: 199000 }, createdAt: new Date() };
  stubNoRecent(t, prior);
  stubSubscription(t, { paidUntil: new Date(Date.now() + 30 * DAY_MS) });
  const create = t.mock.method(WalletTx, 'create', async () => ({}));
  const res = await subscribeAgent(buyer(), 'openclaw', { idempotencyKey: 'click-12345678' });
  assert.equal(res.charged, false);
  assert.equal(res.duplicate, true);
  assert.equal(res.walletTxId, String(prior._id));
  assert.equal(create.mock.callCount(), 0);
});

test('a second manual rental within seconds is refused (double click)', async (t) => {
  stubWallet(t, 50);
  stubNoRecent(t, { _id: new mongoose.Types.ObjectId(), createdAt: new Date() });
  const create = t.mock.method(WalletTx, 'create', async () => ({}));
  await assert.rejects(subscribeAgent(buyer(), 'openclaw'), (err) => err.status === 409 && err.code === 'RENTAL_DUPLICATE');
  assert.equal(create.mock.callCount(), 0);
});

test('concurrent rentals for the same user and agent charge once', async (t) => {
  stubWallet(t, 50);
  stubNoRecent(t);
  const create = t.mock.method(WalletTx, 'create', async (doc) => ({ ...doc, _id: new mongoose.Types.ObjectId() }));
  t.mock.method(LedgerEntry, 'create', async () => ({}));
  t.mock.method(AgentSubscription, 'findOneAndUpdate', () => ({ lean: async () => ({ paidUntil: new Date(Date.now() + 30 * DAY_MS) }) }));
  const Notification = require('../../src/models/Notification');
  t.mock.method(Notification, 'create', async () => ({}));
  const u = buyer();
  const results = await Promise.allSettled([subscribeAgent(u, 'openclaw'), subscribeAgent(u, 'openclaw')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'RENTAL_IN_PROGRESS');
  assert.equal(create.mock.callCount(), 1);
});

test('failed provisioning refunds the rental once and removes the period', async (t) => {
  const u = buyer();
  const txId = new mongoose.Types.ObjectId();
  const tx = { _id: txId, user: u._id, amount: 7.5, currency: 'USD', createdAt: new Date(), meta: { feeVnd: 199000, periodDays: 30 } };
  t.mock.method(WalletTx, 'findOne', () => ({ lean: async () => tx }));
  let claims = 0;
  t.mock.method(WalletTx, 'findOneAndUpdate', () => ({ lean: async () => (claims++ === 0 ? tx : null) }));
  const created = [];
  t.mock.method(WalletTx, 'create', async (doc) => { created.push(doc); return { ...doc, _id: new mongoose.Types.ObjectId() }; });
  t.mock.method(LedgerEntry, 'create', async () => ({}));
  const sub = t.mock.method(AgentSubscription, 'findOneAndUpdate', () => ({ lean: async () => ({ paidUntil: new Date() }) }));
  const Notification = require('../../src/models/Notification');
  t.mock.method(Notification, 'create', async () => ({}));

  const res = await refundFailedRental(u, 'openclaw', String(txId));
  assert.equal(res.refunded, true);
  assert.equal(created[0].type, 'credit');
  assert.equal(created[0].amount, 7.5);
  assert.deepEqual(sub.mock.calls[0].arguments[1][0].$set.paidUntil, { $subtract: ['$paidUntil', 30 * DAY_MS] });

  const again = await refundFailedRental(u, 'openclaw', String(txId));
  assert.equal(again.refunded, false);
  assert.equal(created.length, 1);
});

test('refund is refused after the window', async (t) => {
  const tx = { _id: new mongoose.Types.ObjectId(), amount: 7.5, createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000), meta: {} };
  t.mock.method(WalletTx, 'findOne', () => ({ lean: async () => tx }));
  await assert.rejects(refundFailedRental(buyer(), 'openclaw', String(tx._id)), (err) => err.code === 'REFUND_WINDOW_PASSED');
});

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
  const update = t.mock.method(AgentSubscription, 'findOneAndUpdate', () => ({ lean: async () => null }));
  await assert.rejects(subscribeAgent(buyer(), 'openclaw'), (err) => err.status === 402 && err.code === 'INSUFFICIENT_WALLET');
  assert.equal(update.mock.callCount(), 0);
});

test('subscribing debits one month and books platform revenue', async (t) => {
  stubWallet(t, 50);
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

  const [filter, pipeline] = update.mock.calls[0].arguments;
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

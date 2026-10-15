const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const WalletTx = require('../../src/models/WalletTx');
const LedgerEntry = require('../../src/models/LedgerEntry');
const Order = require('../../src/models/Order');
const UsageEvent = require('../../src/models/UsageEvent');
const User = require('../../src/models/User');
const Notification = require('../../src/models/Notification');
const SshSession = require('../../src/models/SshSession');
const HermesAccount = require('../../src/models/HermesAccount');
const HiredAgent = require('../../src/models/HiredAgent');
const AgentSubscription = require('../../src/models/AgentSubscription');
const { executePurge, markPurged, processSubscription } = require('../../src/finance/agent-subscription-worker');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CFG = { tickMs: 60000, remindDays: 3, renewLeadHours: 24, retryHours: 6 };
const now = new Date('2026-10-04T03:00:00Z');

function setup(t, { role = 'buyer', balance = 50 } = {}) {
  const calls = { notes: [], updates: [], wallet: [], admins: [] };
  t.mock.method(User, 'findById', () => ({
    select: () => ({ lean: async () => ({ _id: 'u1', role, email: 'buyer@example.com' }) }),
  }));
  t.mock.method(User, 'find', () => ({ select: () => ({ lean: async () => [{ _id: 'admin1' }] }) }));
  t.mock.method(Notification, 'create', async (doc) => calls.notes.push(doc));
  t.mock.method(Notification, 'insertMany', async (docs) => calls.admins.push(...docs));
  t.mock.method(AgentSubscription, 'updateOne', async (filter, update) => calls.updates.push(update.$set));
  t.mock.method(WalletTx, 'aggregate', async () => [{ balance }]);
  t.mock.method(UsageEvent, 'aggregate', async () => []);
  t.mock.method(Order, 'find', () => ({ sort: () => ({ lean: async () => [] }) }));
  t.mock.method(WalletTx, 'create', async (doc) => calls.wallet.push(doc));
  t.mock.method(LedgerEntry, 'create', async () => ({}));
  t.mock.method(SshSession, 'find', () => ({ select: () => ({ lean: async () => [{ _id: 's1', agentId: 'nano-claw' }] }) }));
  t.mock.method(SshSession, 'updateMany', async () => ({}));
  t.mock.method(HiredAgent, 'find', () => ({ select: () => ({ lean: async () => [{ _id: 'h1', agentId: 'nano-claw' }] }) }));
  t.mock.method(HiredAgent, 'updateMany', async () => ({}));
  t.mock.method(HermesAccount, 'deleteOne', async () => ({}));
  t.mock.method(AgentSubscription, 'findOneAndUpdate', (filter, update) => ({
    lean: async () =>
      Array.isArray(update)
        ? { _id: 'sub1', paidUntil: new Date(now.getTime() + 31 * DAY) }
        : { _id: 'sub1', ...filter, ...update.$set },
  }));
  return calls;
}

const sub = (over = {}) => ({
  _id: 'sub1',
  user: new mongoose.Types.ObjectId(),
  agentId: 'nanoclaw',
  autoRenew: true,
  paidUntil: new Date(now.getTime() + 12 * HOUR),
  ...over,
});

test('auto-renews from the wallet inside the lead window', async (t) => {
  const calls = setup(t);
  assert.equal(await processSubscription(sub(), now, CFG), 'renewed');
  assert.equal(calls.wallet[0].type, 'debit');
  assert.equal(calls.wallet[0].meta.source, 'auto');
  assert.equal(calls.notes[0].key, 'agent.renewed');
});

test('failed auto-renewal notifies once and doubles as the reminder', async (t) => {
  const calls = setup(t, { balance: 0 });
  assert.equal(await processSubscription(sub(), now, CFG), 'renew_failed');
  assert.equal(calls.wallet.length, 0);
  assert.equal(calls.notes.length, 1);
  assert.equal(calls.notes[0].key, 'agent.renewFailed');
  assert.ok(calls.updates[0].renewFailedFor && calls.updates[0].reminderFor);
});

test('reminds before expiry when auto-renew is off', async (t) => {
  const calls = setup(t);
  const doc = sub({ autoRenew: false, paidUntil: new Date(now.getTime() + 2 * DAY) });
  assert.equal(await processSubscription(doc, now, CFG), 'reminded');
  assert.equal(calls.notes[0].key, 'agent.expiringSoon');
  assert.equal(calls.wallet.length, 0);
});

test('expiry locks the agent, revokes SSH and schedules the purge', async (t) => {
  const calls = setup(t);
  const paidUntil = new Date(now.getTime() - HOUR);
  const doc = sub({ autoRenew: false, paidUntil });
  assert.equal(await processSubscription(doc, now, CFG), 'expired');
  assert.equal(calls.updates[0].purgeDueAt.getTime(), paidUntil.getTime() + 30 * DAY);
  assert.equal(SshSession.updateMany.mock.callCount(), 1);
  assert.equal(calls.notes[0].key, 'agent.expired');
});

test('purge without a runtime webhook is queued for admins', async (t) => {
  const calls = setup(t);
  const paidUntil = new Date(now.getTime() - 31 * DAY);
  const doc = sub({ autoRenew: false, paidUntil, expiredFor: paidUntil, purgeDueAt: new Date(now.getTime() - HOUR) });
  assert.equal(await processSubscription(doc, now, CFG), 'purge_manual_required');
  assert.equal(calls.updates.at(-1).purgeStatus, 'manual_required');
  assert.equal(calls.admins[0].key, 'agent.purgeManual');
  assert.equal(HiredAgent.updateMany.mock.callCount(), 1);
});

test('purge calls the runtime webhook and notifies the buyer', async (t) => {
  const calls = setup(t);
  process.env.NANOCLAW_AIMARKETS_PURGE_URL = 'https://{userId}.nanoclaw.aimarkets.vn/api/aimarkets/purge';
  process.env.NANOCLAW_SSO_SECRET = 'test-secret';
  t.after(() => {
    delete process.env.NANOCLAW_AIMARKETS_PURGE_URL;
    delete process.env.NANOCLAW_SSO_SECRET;
  });
  const fetchMock = t.mock.method(global, 'fetch', async () => ({ ok: true, status: 200 }));
  const paidUntil = new Date(now.getTime() - 31 * DAY);
  const doc = sub({ autoRenew: false, paidUntil, expiredFor: paidUntil, purgeDueAt: new Date(now.getTime() - HOUR) });
  assert.equal(await processSubscription(doc, now, CFG), 'purged');
  const [url, init] = fetchMock.mock.calls[0].arguments;
  assert.equal(url, `https://${String(doc.user)}.nanoclaw.aimarkets.vn/api/aimarkets/purge`);
  assert.equal(init.headers['X-Runtime-Secret'], 'test-secret');
  assert.equal(calls.updates.at(-1).purgeStatus, 'done');
  assert.equal(calls.notes.at(-1).key, 'agent.purged');
});

test('admin retry records the webhook error without re-notifying admins', async (t) => {
  const calls = setup(t);
  process.env.NANOCLAW_AIMARKETS_PURGE_URL = 'https://{userId}.nanoclaw.aimarkets.vn/api/aimarkets/purge';
  process.env.NANOCLAW_SSO_SECRET = 'test-secret';
  t.after(() => {
    delete process.env.NANOCLAW_AIMARKETS_PURGE_URL;
    delete process.env.NANOCLAW_SSO_SECRET;
  });
  t.mock.method(global, 'fetch', async () => ({ ok: false, status: 502 }));
  const doc = sub({ paidUntil: new Date(now.getTime() - 31 * DAY), purgeStatus: 'failed' });
  assert.equal(await executePurge(doc, { _id: 'u1' }, now, { notifyAdmins: false }), 'failed');
  assert.deepEqual(calls.updates.at(-1), { purgeStatus: 'failed', purgeAttemptedAt: now, purgeError: 'Webhook HTTP 502' });
  assert.equal(calls.admins.length, 0);
});

test('manual purge confirmation stores the admin and the note', async (t) => {
  const calls = setup(t);
  const admin = new mongoose.Types.ObjectId();
  await markPurged(sub(), { _id: 'u1' }, now, { by: admin, note: 'rm -rf workspace market-x' });
  assert.equal(calls.updates[0].purgeStatus, 'done');
  assert.equal(calls.updates[0].purgedBy, admin);
  assert.equal(calls.updates[0].purgeNote, 'rm -rf workspace market-x');
  assert.equal(calls.notes[0].key, 'agent.purged');
});

test('admins are never billed or purged', async (t) => {
  const calls = setup(t, { role: 'admin' });
  assert.equal(await processSubscription(sub(), now, CFG), 'skip');
  assert.equal(calls.wallet.length, 0);
});

test('never auto-renews a plan whose last charge was refunded', async (t) => {
  const calls = setup(t);
  const doc = sub({
    paidUntil: new Date(now.getTime() - 5 * 60 * 1000),
    lastChargedAt: new Date(now.getTime() - 40 * 60 * 1000),
    lastRefundedAt: new Date(now.getTime() - 10 * 60 * 1000),
  });
  const r = await processSubscription(doc, now, CFG);
  assert.notEqual(r, 'renewed');
  assert.equal(calls.wallet.length, 0);
});

test('a refund older than a newer manual charge does not block renewal', async (t) => {
  const calls = setup(t);
  const doc = sub({
    lastRefundedAt: new Date(now.getTime() - 20 * DAY),
    lastChargedAt: new Date(now.getTime() - 10 * DAY),
  });
  assert.equal(await processSubscription(doc, now, CFG), 'renewed');
  assert.equal(calls.wallet.length, 1);
});

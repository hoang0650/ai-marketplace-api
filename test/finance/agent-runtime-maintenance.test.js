const test = require('node:test');
const assert = require('node:assert/strict');
const WalletTx = require('../../src/models/WalletTx');
const AgentSubscription = require('../../src/models/AgentSubscription');
const User = require('../../src/models/User');
const { subscribeAgent } = require('../../src/finance/agent-subscription');
const { processSubscription } = require('../../src/finance/agent-subscription-worker');
const { runtimeAvailability } = require('../../src/utils/agent-runtime-availability');

for (const id of ['hermes', 'spacebot', 'nanoclaw']) {
  test(`${id} maintenance refuses manual and automatic charges before wallet access`, async t => {
    const key = `${id.toUpperCase()}_BUYER_RUNTIME_ENABLED`, old = process.env[key];
    process.env[key] = '0';
    t.after(() => old === undefined ? delete process.env[key] : process.env[key] = old);
    const writes = t.mock.method(WalletTx, 'create', () => { throw Error('Wallet must not be touched'); });
    const plans = t.mock.method(AgentSubscription, 'findOne', () => { throw Error('Plan must not be touched'); });
    for (const source of ['manual', 'auto']) {
      await assert.rejects(subscribeAgent({ _id: 'buyer', role: 'buyer' }, id, { source }),
        e => e.status === 503 && e.code === 'RUNTIME_ISOLATION_MAINTENANCE');
    }
    assert.equal(writes.mock.callCount(), 0);
    assert.equal(plans.mock.callCount(), 0);
  });
  test(`${id} maintenance worker preserves even expired workspaces`, async t => {
    const key = `${id.toUpperCase()}_BUYER_RUNTIME_ENABLED`, old = process.env[key];
    process.env[key] = '0';
    t.after(() => old === undefined ? delete process.env[key] : process.env[key] = old);
    const users = t.mock.method(User, 'findById', () => { throw Error('Maintenance must return before billing or purge'); });
    assert.equal(await processSubscription({ agentId: id, paidUntil: new Date(0), purgeDueAt: new Date(0) }), 'maintenance');
    assert.equal(users.mock.callCount(), 0);
  });
}
test('availability preserves unaffected agents and only explicit readiness enables NanoClaw', () => {
  assert.equal(runtimeAvailability('openclaw', {}).available, true);
  assert.equal(runtimeAvailability('paperclip', {}).available, true);
  assert.equal(runtimeAvailability('openwebui', {}).available, true);
  assert.equal(runtimeAvailability('nanoclaw', {}).available, false);
  for (const id of ['hermes', 'spacebot', 'nanoclaw']) {
    assert.equal(runtimeAvailability(id, { [`${id.toUpperCase()}_BUYER_RUNTIME_ENABLED`]: '1' }).available, true);
  }
});

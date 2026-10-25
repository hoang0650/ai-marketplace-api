const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const GameSession = require('../../src/models/GameSession');
const GpuServer = require('../../src/models/GpuServer');
const provider = require('../../src/utils/gpu-rental/provider');
const hosting = require('../../src/utils/game-hosting');
const billing = require('../../src/utils/game-billing');
const { buildGameServerProducts } = require('../../src/data/game-server-products');
const { buildComputeTestProducts, RETIRED_GAME_SLUGS } = require('../../src/data/compute-test-products');

const saved = [];
function stub(obj, key, fn) {
  saved.push([obj, key, obj[key]]);
  obj[key] = fn;
}
afterEach(() => {
  while (saved.length) {
    const [obj, key, orig] = saved.pop();
    obj[key] = orig;
  }
});

const creator = new mongoose.Types.ObjectId();
const buyer = new mongoose.Types.ObjectId();
const product = { ...buildGameServerProducts()[0], _id: new mongoose.Types.ObjectId(), creator };

describe('dedicated game servers', () => {
  test('catalog: real TCP game servers replace the sandbox demos', () => {
    const games = buildGameServerProducts();
    assert.deepEqual(games.map((g) => g.slug), [
      'game-server-minecraft-java',
      'game-server-minecraft-paper',
      'game-server-terraria',
    ]);
    for (const g of games) {
      assert.ok(hosting.isDedicatedProduct(g));
      assert.equal(g.gameServer.computeType, 'CPU');
      assert.ok(!g.gameServer.dataCenterIds.includes('EU-SE-1'));
      assert.equal(g.pricing.usageUnit, 'minute');
    }
    const compute = buildComputeTestProducts().map((p) => p.slug);
    for (const s of RETIRED_GAME_SLUGS) assert.ok(!compute.includes(s));
  });

  test('rate = (pod cost + running disk) x (1 + markup)', () => {
    const rate = hosting.dedicatedRatePerHour(0.08, 10, { markup: 0.3, storageRunningGbMonth: 0.1 });
    assert.equal(rate, Math.round((0.08 + (10 * 0.1) / 730) * 1.3 * 1e6) / 1e6);
    assert.ok(rate / 0.08 > 1.3 && rate / 0.08 < 1.33);
  });

  test('session rate uses the pod cost of that session; owner plays free', () => {
    const s = { user: buyer, dedicated: true, ratePerHour: 0.106 };
    assert.equal(billing.sessionRate(s, product), 0.106);
    assert.equal(billing.sessionRate({ ...s, user: creator }, product), 0);
  });

  test('nothing is billed before the server answers', async () => {
    const s = { _id: new mongoose.Types.ObjectId(), user: buyer, dedicated: true, ratePerHour: 6, readyAt: null, createdAt: new Date(Date.now() - 30 * 60_000) };
    stub(GameSession, 'findOneAndUpdate', async () => {
      throw new Error('must not move the billing cursor');
    });
    assert.equal(await billing.settleSession(s, product, new Date()), 0);
  });

  test('launch creates a CPU pod with the game port and a starting session', async () => {
    let spec;
    stub(provider, 'createServer', async (s) => {
      spec = s;
      return { id: 'pod123', status: 'running', costPerHour: 0.08 };
    });
    stub(GpuServer, 'create', async (doc) => ({ ...doc, _id: new mongoose.Types.ObjectId() }));
    stub(GameSession, 'create', async (doc) => doc);
    const doc = await hosting.launchDedicatedServer({
      product,
      user: { _id: buyer },
      sessionId: 'gs_abcdef123456',
      client: 'pc',
      device: 'pc',
    });
    assert.equal(spec.computeType, 'CPU');
    assert.equal(spec.ports, '25565/tcp');
    assert.equal(spec.image, 'itzg/minecraft-server:latest');
    assert.equal(spec.env.EULA, 'TRUE');
    assert.equal(doc.status, 'starting');
    assert.equal(doc.dedicated, true);
    assert.equal(doc.providerServerId, 'pod123');
    assert.equal(doc.podCostPerHour, 0.08);
    assert.ok(doc.ratePerHour > 0.104 && doc.ratePerHour < 0.106);
  });

  test('a failed session insert terminates the pod (no orphans)', async () => {
    let terminated = '';
    stub(provider, 'createServer', async () => ({ id: 'pod-orphan', costPerHour: 0.08 }));
    stub(provider, 'terminateServer', async (id) => {
      terminated = id;
      return { id, status: 'terminated' };
    });
    stub(GpuServer, 'create', async () => {
      throw new Error('db down');
    });
    await assert.rejects(
      hosting.launchDedicatedServer({ product, user: { _id: buyer }, sessionId: 'gs_x', client: 'pc', device: 'pc' }),
    );
    assert.equal(terminated, 'pod-orphan');
  });

  test('ready probe flips the session live and starts billing then', async () => {
    stub(provider, 'tcpEndpoint', async () => ({ host: '203.0.113.5', port: 22163 }));
    stub(hosting, 'probeTcp', async () => true);
    let update;
    stub(GameSession, 'findOneAndUpdate', async (_q, u) => {
      update = u.$set;
      return { ...u.$set, dedicated: true };
    });
    stub(GpuServer, 'updateOne', async () => ({}));
    const s = { _id: new mongoose.Types.ObjectId(), dedicated: true, status: 'starting', providerServerId: 'pod1', privatePort: 25565, createdAt: new Date() };
    const live = await hosting.refreshDedicated(s);
    assert.equal(live.status, 'live');
    assert.equal(update.connectHost, '203.0.113.5');
    assert.equal(update.connectPort, 22163);
    assert.ok(update.billingStartedAt instanceof Date);
  });

  test('teardown terminates the pod once', async () => {
    const calls = [];
    stub(provider, 'terminateServer', async (id) => calls.push(id));
    stub(GameSession, 'updateOne', async () => ({}));
    stub(GpuServer, 'updateOne', async () => ({}));
    const s = { _id: new mongoose.Types.ObjectId(), dedicated: true, providerServerId: 'podT', server: new mongoose.Types.ObjectId() };
    assert.equal(await hosting.teardownDedicated(s), true);
    assert.equal(await hosting.teardownDedicated(s), true);
    assert.deepEqual(calls, ['podT']);
  });
});

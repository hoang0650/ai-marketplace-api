const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const GameSession = require('../../src/models/GameSession');
const GpuServer = require('../../src/models/GpuServer');
const Product = require('../../src/models/Product');
const WalletTx = require('../../src/models/WalletTx');
const WalletLock = require('../../src/models/WalletLock');
const AffiliateCommission = require('../../src/models/AffiliateCommission');
const Order = require('../../src/models/Order');
const UsageEvent = require('../../src/models/UsageEvent');
const UsageStat = require('../../src/models/UsageStat');
const Notification = require('../../src/models/Notification');
const billing = require('../../src/utils/game-billing');
const clients = require('../../src/utils/stream-clients');
const { usageRatePerHour, streamFromServer } = require('../../src/utils/compute-session');
const { mapProduct } = require('../../src/utils/mappers');

const saved = [];
function stub(obj, key, fn) {
  saved.push([obj, key, obj[key]]);
  obj[key] = fn;
}
function restoreAll() {
  while (saved.length) {
    const [obj, key, orig] = saved.pop();
    obj[key] = orig;
  }
}

const t0 = new Date('2026-01-01T00:00:00Z');
const sellerId = new mongoose.Types.ObjectId();

function makeProduct(over = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    slug: 'game-box',
    name: 'Game Box',
    category: 'game-server',
    creator: sellerId,
    ownershipType: 'THIRD_PARTY_SELLER',
    pricing: { model: 'usage', price: 0, currency: 'USD', usageUnit: 'minute', usageRate: 0.05 },
    ...over,
  };
}

function makeSession(over = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    sessionId: 'gs_test',
    user: new mongoose.Types.ObjectId(),
    server: new mongoose.Types.ObjectId(),
    product: new mongoose.Types.ObjectId(),
    status: 'live',
    client: 'android',
    device: 'mobile',
    hosting: 'external',
    billingStartedAt: t0,
    billedUntil: t0,
    billingCarry: 0,
    billedCost: 0,
    billedMinutes: 0,
    lastActivityAt: t0,
    heartbeatAt: t0,
    createdAt: t0,
    ...over,
  };
}

function stubLedger(balance) {
  stub(WalletTx, 'aggregate', async () => [{ balance }]);
  stub(AffiliateCommission, 'find', () => ({ lean: async () => [] }));
  stub(WalletLock, 'findOneAndUpdate', async () => ({}));
  stub(WalletLock, 'deleteOne', async () => ({}));
  stub(Order, 'find', () => ({ sort: () => ({ lean: async () => [] }) }));
  stub(UsageEvent, 'aggregate', async () => []);
}

describe('stream clients (PC vs mobile)', () => {
  test('explicit client wins over user agent', () => {
    assert.deepEqual(clients.resolveClient('ios', 'Mozilla/5.0 (Windows NT 10.0)'), { client: 'ios', device: 'mobile' });
    assert.deepEqual(clients.resolveClient('pc', 'Mozilla/5.0 (Linux; Android 14)'), { client: 'pc', device: 'pc' });
  });

  test('falls back to user agent and maps generic aliases', () => {
    assert.deepEqual(clients.resolveClient('', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), { client: 'ios', device: 'mobile' });
    assert.deepEqual(clients.resolveClient(undefined, 'okhttp Android'), { client: 'android', device: 'mobile' });
    assert.deepEqual(clients.resolveClient('web', 'Android'), { client: 'pc', device: 'pc' });
    assert.deepEqual(clients.resolveClient('mobile', 'curl'), { client: 'android', device: 'mobile' });
  });

  test('profiles: PC is high quality, mobile is landscape + touch + lower bitrate', () => {
    const pc = clients.streamProfile('pc');
    const mobile = clients.streamProfile('mobile');
    assert.ok(pc.inputs.includes('keyboard') && pc.inputs.includes('mouse'));
    assert.ok(mobile.inputs.includes('touch'));
    assert.equal(mobile.orientation, 'landscape');
    assert.ok(mobile.bitrateKbps < pc.bitrateKbps);
    assert.ok(mobile.maxHeight < pc.maxHeight);
  });

  test('device support check rejects the unsupported client', () => {
    const pcOnly = makeProduct({ streaming: { devices: ['pc'] } });
    assert.deepEqual(clients.assertDeviceSupported(pcOnly, 'pc'), ['pc']);
    assert.throws(
      () => clients.assertDeviceSupported(pcOnly, 'mobile'),
      (err) => err.status === 409 && err.code === 'CLIENT_NOT_SUPPORTED' && err.body.supportedDevices[0] === 'pc'
    );
    assert.deepEqual(clients.productDevices(makeProduct()), ['pc', 'mobile']);
    assert.deepEqual(clients.normalizeDevices(['MOBILE', 'tv']), ['mobile']);
    assert.deepEqual(clients.normalizeDevices([]), ['pc', 'mobile']);
  });

  test('mobile session uses the seller mobile stream override, PC keeps the main stream', () => {
    const node = {
      kind: 'game',
      external: true,
      streamKind: 'novnc',
      streamHost: '10.0.0.5',
      streamPort: 6080,
      streamPath: '/vnc.html',
      mobileStream: { host: '10.0.0.5', port: 6081, path: '/m.html', kind: '' },
    };
    assert.equal(streamFromServer(node, 'pc').port, 6080);
    const m = streamFromServer(node, 'mobile');
    assert.equal(m.port, 6081);
    assert.equal(m.path, '/m.html');
    assert.equal(m.kind, 'novnc');
    assert.equal(streamFromServer({ ...node, mobileStream: {} }, 'mobile').port, 6080);
  });

  test('catalog exposes devices and platform rental only for compute listings', () => {
    const platform = mapProduct(
      makeProduct({
        category: 'gpu-compute',
        ownershipType: 'PLATFORM_DIRECT',
        creatorSlug: 'aimarkets',
        streaming: { devices: ['pc'], rentalOfferId: 'NVIDIA L40S' },
      })
    );
    assert.deepEqual(platform.streaming.devices, ['pc']);
    assert.equal(platform.streaming.platformRental, true);
    const seller = mapProduct(makeProduct({ creatorSlug: 's', streaming: { rentalOfferId: 'x' } }));
    assert.equal(seller.streaming.platformRental, false);
    assert.equal(mapProduct(makeProduct({ category: 'agent', creatorSlug: 's' })).streaming, undefined);
  });
});

describe('game session per-minute billing', () => {
  let debits;
  let credits;
  let events;
  let notes;
  let casResult;
  beforeEach(() => {
    debits = [];
    credits = [];
    events = [];
    notes = [];
    casResult = undefined;
    stub(WalletTx, 'create', async (doc) => {
      (doc.type === 'debit' ? debits : credits).push(doc);
      return doc;
    });
    stub(UsageEvent, 'create', async (doc) => {
      events.push(doc);
      return doc;
    });
    stub(UsageStat, 'updateOne', async () => ({}));
    stub(Notification, 'create', async (doc) => {
      notes.push(doc);
      return doc;
    });
    stub(GameSession, 'updateOne', async () => ({}));
    stub(GameSession, 'findOneAndUpdate', async (q, u) => {
      if (casResult === null) return null;
      if (u.$set?.status === 'stopped') return { ...q, ...u.$set };
      return {
        billedUntil: u.$set.billedUntil,
        billingCarry: u.$set.billingCarry,
        billedMinutes: u.$inc.billedMinutes,
        billedCost: u.$inc.billedCost,
      };
    });
    stubLedger(100);
    stub(GpuServer, 'findById', async () => null);
    stub(Product, 'findById', () => ({ lean: async () => null }));
  });
  afterEach(restoreAll);

  test('rate per hour follows the listing usage unit', () => {
    assert.equal(usageRatePerHour(makeProduct()), 3);
    assert.equal(usageRatePerHour(makeProduct({ pricing: { model: 'usage', usageUnit: 'hour', usageRate: 1.2 } })), 1.2);
    assert.equal(usageRatePerHour(makeProduct({ pricing: { model: 'free', usageRate: 9 } })), 0);
  });

  test('accrue: final stop rounds the last partial minute up', () => {
    const a = billing.accrue({ from: t0, carry: 0 }, 3, new Date(t0.getTime() + 10_000), { final: true });
    assert.equal(a.minutes, 1);
    assert.equal(a.charge, 0.05);
    const b = billing.accrue({ from: t0, carry: 0 }, 3, new Date(t0.getTime() + 10_000));
    assert.equal(b.minutes, 0);
  });

  test('settle charges the buyer, credits seller net and logs usage per device', async () => {
    const s = makeSession();
    const p = makeProduct();
    const charged = await billing.settleSession(s, p, new Date(t0.getTime() + 10 * 60_000));
    assert.equal(charged, 0.5);
    assert.equal(debits.length, 1);
    assert.equal(debits[0].amount, 0.5);
    assert.equal(String(debits[0].user), String(s.user));
    assert.equal(credits.length, 1);
    assert.equal(String(credits[0].user), String(sellerId));
    assert.ok(credits[0].amount > 0 && credits[0].amount < 0.5);
    assert.equal(events[0].rawUsage.device, 'mobile');
    assert.equal(events[0].usageType, 'GAME_RUNTIME');
    assert.equal(s.billedMinutes, 10);
    assert.equal(s.billedUntil.getTime(), t0.getTime() + 10 * 60_000);
  });

  test('platform listing: buyer debited, no seller credit', async () => {
    const s = makeSession();
    const p = makeProduct({ ownershipType: 'PLATFORM_DIRECT' });
    await billing.settleSession(s, p, new Date(t0.getTime() + 2 * 60_000));
    assert.equal(debits.length, 1);
    assert.equal(credits.length, 0);
  });

  test('settle is a no-op when another worker moved the cursor', async () => {
    casResult = null;
    const charged = await billing.settleSession(makeSession(), makeProduct(), new Date(t0.getTime() + 5 * 60_000));
    assert.equal(charged, 0);
    assert.equal(debits.length, 0);
  });

  test('seller playing their own listing is never charged', async () => {
    const s = makeSession({ user: sellerId });
    await billing.settleSession(s, makeProduct(), new Date(t0.getTime() + 30 * 60_000));
    assert.equal(debits.length, 0);
  });

  test('stops when the buyer cannot cover the next minute', async () => {
    stubLedger(0.01);
    const now = new Date(t0.getTime() + 60_000);
    const s = makeSession({ lastActivityAt: now, heartbeatAt: now });
    const r = await billing.enforceSession(s, makeProduct(), now);
    assert.equal(r, 'stopped');
    assert.equal(s.status, 'stopped');
    assert.equal(s.stopReason, 'insufficient_funds');
    assert.equal(notes[0].key, 'stream.stoppedNoFunds');
  });

  test('warns once when balance covers fewer than warnMinutes', async () => {
    stubLedger(0.12);
    const now = new Date(t0.getTime() + 60_000);
    const s = makeSession({ lastActivityAt: now, heartbeatAt: now });
    assert.equal(await billing.enforceSession(s, makeProduct(), now), 'warned');
    assert.equal(await billing.enforceSession(s, makeProduct(), now), 'ok');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].key, 'stream.lowBalance');
  });

  test('idle: heartbeat clients stop after silence, legacy clients get the long cap', async () => {
    stubLedger(100);
    const idleMs = billing.gameBillingConfig().idleMs;
    const late = new Date(t0.getTime() + idleMs + 60_000);
    const hb = makeSession();
    assert.equal(await billing.enforceSession(hb, makeProduct(), late), 'idle');
    assert.equal(hb.stopReason, 'idle');

    const legacy = makeSession({ heartbeatAt: null });
    assert.equal(await billing.enforceSession(legacy, makeProduct(), late), 'ok');
    const veryLate = new Date(t0.getTime() + billing.gameBillingConfig().noHeartbeatMaxMs + 60_000);
    assert.equal(await billing.enforceSession(legacy, makeProduct(), veryLate), 'idle');
  });

  test('stop bills the tail once with a minimum of one minute', async () => {
    const p = makeProduct();
    stub(Product, 'findById', () => ({ lean: async () => p }));
    const s = makeSession({ billedUntil: new Date(Date.now() - 20_000), billingStartedAt: new Date(Date.now() - 20_000) });
    await billing.stopGameSession(s, 'user');
    assert.equal(s.status, 'stopped');
    assert.equal(debits.length, 1);
    assert.equal(debits[0].amount, 0.05);
    assert.equal(s.billedMinutes, 1);
  });
});

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const GpuRental = require('../../src/models/GpuRental');
const GpuVolume = require('../../src/models/GpuVolume');
const WalletTx = require('../../src/models/WalletTx');
const WalletLock = require('../../src/models/WalletLock');
const AffiliateCommission = require('../../src/models/AffiliateCommission');
const Order = require('../../src/models/Order');
const UsageEvent = require('../../src/models/UsageEvent');
const { toOffer, volumeQuote, isFitGpu, quote } = require('../../src/utils/gpu-rental/pricing');
const { gpuRentalConfig } = require('../../src/utils/gpu-rental/config');
const provider = require('../../src/utils/gpu-rental/provider');
const svc = require('../../src/utils/gpu-rental/service');

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
function stubLedger(balance) {
  stub(WalletTx, 'aggregate', async () => [{ balance }]);
  stub(AffiliateCommission, 'find', () => ({ lean: async () => [] }));
  stub(WalletLock, 'findOneAndUpdate', async () => ({}));
  stub(WalletLock, 'deleteOne', async () => ({}));
  stub(Order, 'find', () => ({ sort: () => ({ lean: async () => [] }) }));
  stub(UsageEvent, 'aggregate', async () => []);
}

const CATALOG = {
  gpuTypes: [
    {
      id: 'NVIDIA RTX 2000 Ada Generation',
      name: 'RTX 2000 Ada',
      memoryGb: 16,
      clouds: { secure: { costPerHour: 0.24, stock: 'low', dataCenters: [{ id: 'EU-RO-1', stock: 'low' }] } },
    },
    {
      id: 'NVIDIA GeForce RTX 3090',
      name: 'RTX 3090',
      memoryGb: 24,
      clouds: {
        secure: { costPerHour: 0.46, stock: 'high', dataCenters: [{ id: 'US-KS-2', stock: 'high' }] },
        community: { costPerHour: 0.22, stock: 'medium' },
      },
    },
    { id: 'AMD Instinct MI300X OAM', name: 'MI300X', memoryGb: 192, clouds: { secure: { costPerHour: 2.5, stock: 'high', dataCenters: [] } } },
  ],
  dataCenters: [
    { id: 'EU-RO-1', location: 'Europe', storageSupport: true, gpus: {} },
    { id: 'US-KS-2', location: 'United States', storageSupport: true, gpus: {} },
    { id: 'XX-NOSTORE', location: 'Nowhere', storageSupport: false, gpus: {} },
  ],
};

describe('gpu catalog offers', () => {
  const cfg = { ...gpuRentalConfig(), markup: 0.32, minPricePerHour: 0.2, storageRunningGbMonth: 0.1 };

  test('per-cloud sell price = (gpu + disk) × 1.32, per hour and per minute, cost hidden', () => {
    const o = toOffer(CATALOG.gpuTypes[1], cfg);
    const sec = o.clouds.find((c) => c.type === 'secure');
    const com = o.clouds.find((c) => c.type === 'community');
    assert.equal(sec.pricePerHour, quote({ costPerHour: 0.46 }, cfg).pricePerHour);
    assert.equal(com.pricePerHour, quote({ costPerHour: 0.22 }, cfg).pricePerHour);
    assert.equal(o.pricePerHour, com.pricePerHour); // cheapest cloud on top
    assert.equal(o.availability, 'high');
    assert.equal(sec.pricePerMinute, Math.round((sec.pricePerHour / 60) * 1e4) / 1e4);
    assert.deepEqual(sec.dataCenters, [{ id: 'US-KS-2', availability: 'high' }]);
    assert.ok(!JSON.stringify(o).includes('0.46'));
  });

  test('clouds without stock are hidden; nothing rentable -> no offer', () => {
    assert.equal(toOffer({ id: 'NVIDIA X', name: 'X', memoryGb: 24, clouds: { secure: { costPerHour: 1, stock: '' } } }, cfg), null);
  });

  test('unfit GPUs (non-NVIDIA or tiny VRAM) are filtered', () => {
    assert.equal(isFitGpu(CATALOG.gpuTypes[2], cfg), false);
    assert.equal(isFitGpu({ id: 'NVIDIA GeForce RTX 3070', memoryGb: 4 }, cfg), false);
    assert.equal(isFitGpu(CATALOG.gpuTypes[0], cfg), true);
  });

  test('network volume price = GB-month × 1.32, hourly derived from 730h', () => {
    const q = volumeQuote(10, { ...cfg, volumeGbMonth: 0.07 });
    assert.equal(q.pricePerGbMonth, 0.0924);
    assert.equal(q.pricePerMonth, 0.93);
    assert.equal(q.pricePerHour, Math.round((0.924 / 730) * 1e6) / 1e6);
  });
});

describe('gpu network volumes', () => {
  const user = { _id: new mongoose.Types.ObjectId(), role: 'user' };
  let created;

  beforeEach(() => {
    svc.resetOffersCache();
    stub(provider, 'gpuCatalog', async () => CATALOG);
    stubLedger(50);
    created = [];
  });
  afterEach(restoreAll);

  test('data centers list storage-capable ones with in-stock GPU counts', async () => {
    const dcs = await svc.publicDataCenters();
    assert.deepEqual(dcs.map((d) => d.id).sort(), ['EU-RO-1', 'US-KS-2']);
    assert.equal(dcs.find((d) => d.id === 'EU-RO-1').gpuCount, 1);
  });

  test('public offers hide the unfit AMD GPU', async () => {
    const offers = await svc.publicOffers();
    assert.deepEqual(offers.map((o) => o.name).sort(), ['RTX 2000 Ada', 'RTX 3090']);
  });

  test('createVolume uses the aim-vol- prefix and never exposes the upstream id', async () => {
    stub(GpuVolume, 'countDocuments', async () => 0);
    stub(GpuVolume, 'create', async (doc) => {
      const v = new GpuVolume(doc);
      v.save = async () => v;
      created.push(v);
      return v;
    });
    let sent;
    stub(provider, 'createVolume', async (spec) => {
      sent = spec;
      return { id: 'upvol123', name: spec.name, sizeGb: spec.sizeGb, dataCenterId: spec.dataCenterId };
    });
    const vol = await svc.createVolume(user, { name: 'data', sizeGb: 10, dataCenterId: 'EU-RO-1' });
    assert.match(sent.name, /^aim-vol-/);
    assert.equal(vol.status, 'active');
    assert.equal(vol.providerVolumeId, 'upvol123');
    const pub = svc.publicVolume(vol);
    assert.ok(!JSON.stringify(pub).includes('upvol123'));
    assert.equal(pub.mountPath, '/workspace');
  });

  test('createVolume rejects non-storage data centers and bad sizes', async () => {
    await assert.rejects(svc.createVolume(user, { sizeGb: 10, dataCenterId: 'XX-NOSTORE' }), { code: 'DATA_CENTER_INVALID' });
    await assert.rejects(svc.createVolume(user, { sizeGb: 5, dataCenterId: 'EU-RO-1' }), { code: 'VOLUME_SIZE_INVALID' });
  });

  function volumeDoc(dc = 'EU-RO-1') {
    const v = new GpuVolume({
      owner: user._id, name: 'data', dataCenterId: dc, sizeGb: 10, providerVolumeId: 'upvol1', status: 'active',
      pricePerHour: 0.001266, billedUntil: new Date(),
    });
    v.save = async () => v;
    return v;
  }

  test('rental with a volume is secure-only, pinned to its data center and mounts /workspace', async () => {
    const vol = volumeDoc();
    stub(GpuVolume, 'findOne', async () => vol);
    stub(GpuRental, 'countDocuments', async () => 0);
    stub(GpuRental, 'create', async (doc) => {
      const r = new GpuRental(doc);
      r.save = async () => r;
      return r;
    });
    let spec;
    stub(provider, 'createServer', async (s) => {
      spec = s;
      return { id: 'pod1', status: 'creating', costPerHour: 0, dataCenterId: 'EU-RO-1' };
    });
    const r = await svc.createRental(user, { offerId: 'NVIDIA RTX 2000 Ada Generation', volumeId: String(vol._id) });
    assert.equal(spec.networkVolumeId, 'upvol1');
    assert.deepEqual(spec.dataCenterIds, ['EU-RO-1']);
    assert.equal(spec.cloudType, 'SECURE');
    assert.equal(spec.volumeGb, 0);
    assert.equal(r.stoppedPricePerHour, 0);
    assert.equal(r.cloudType, 'secure');
    assert.equal(String(r.volume), String(vol._id));
  });

  test('a GPU not stocked in the volume data center is refused', async () => {
    const vol = volumeDoc('EU-RO-1');
    stub(GpuVolume, 'findOne', async () => vol);
    stub(GpuRental, 'countDocuments', async () => 0);
    await assert.rejects(
      svc.createRental(user, { offerId: 'NVIDIA GeForce RTX 3090', volumeId: String(vol._id) }),
      { code: 'GPU_UNAVAILABLE_IN_DC' }
    );
  });

  test('community cloud rental uses the community price', async () => {
    stub(GpuRental, 'countDocuments', async () => 0);
    stub(GpuRental, 'create', async (doc) => {
      const r = new GpuRental(doc);
      r.save = async () => r;
      return r;
    });
    let spec;
    stub(provider, 'createServer', async (s) => {
      spec = s;
      return { id: 'pod2', status: 'creating', costPerHour: 0 };
    });
    const r = await svc.createRental(user, { offerId: 'NVIDIA GeForce RTX 3090', cloud: 'community' });
    assert.equal(spec.cloudType, 'COMMUNITY');
    assert.equal(r.costPerHour, 0.22);
    assert.equal(spec.networkVolumeId, undefined);
  });

  test('a volume in use cannot be deleted; stopping a volume pod ends it (data stays on the volume)', async () => {
    const vol = volumeDoc();
    stub(GpuRental, 'countDocuments', async () => 1);
    await assert.rejects(svc.deleteVolume(vol), { code: 'VOLUME_IN_USE' });
    // Final settle reloads the rental after a lost compare-and-set. No Mongo in unit tests.
    stub(GpuRental, 'findById', () => ({ lean: async () => null }));

    const r = new GpuRental({
      owner: user._id, name: 'ws', offerId: 'x', gpuName: 'x', providerServerId: 'pod9', status: 'running', ready: true,
      pricePerHour: 0.33, stoppedPricePerHour: 0, billedUntil: new Date(), volume: vol._id,
    });
    r.save = async () => r;
    stub(GpuRental, 'findOneAndUpdate', async () => null);
    let terminated = '';
    stub(provider, 'terminateServer', async (id) => {
      terminated = id;
      return { id, status: 'terminated' };
    });
    stub(provider, 'stopServer', async () => {
      throw new Error('must not stop');
    });
    await svc.stopRental(r, 'user');
    assert.equal(terminated, 'pod9');
    assert.equal(r.status, 'terminated');
    assert.equal(r.stoppedReason, 'user');
  });

  test('volume storage is billed per minute on channel gpu-volume', async () => {
    const vol = volumeDoc();
    vol.pricePerHour = 0.6;
    vol.billedUntil = new Date(Date.now() - 10 * 60_000);
    stub(GpuVolume, 'findOneAndUpdate', async (q, u) => ({ ...u.$set, billedMinutes: 10, billedTotal: 0.1 }));
    let tx;
    stub(WalletTx, 'create', async (doc) => {
      tx = doc;
      return doc;
    });
    const charged = await svc.settleVolume(vol, new Date());
    assert.equal(charged, 0.1);
    assert.equal(tx.meta.channel, 'gpu-volume');
    assert.equal(tx.meta.volumeId, String(vol._id));
  });
});

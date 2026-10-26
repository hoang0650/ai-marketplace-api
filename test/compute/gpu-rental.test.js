const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const config = require('../../src/config/env');
const GpuRental = require('../../src/models/GpuRental');
const WalletTx = require('../../src/models/WalletTx');
const WalletLock = require('../../src/models/WalletLock');
const AffiliateCommission = require('../../src/models/AffiliateCommission');
const Order = require('../../src/models/Order');
const UsageEvent = require('../../src/models/UsageEvent');
const Notification = require('../../src/models/Notification');
const { quote, toOffer, ceilCents } = require('../../src/utils/gpu-rental/pricing');
const { gpuRentalConfig } = require('../../src/utils/gpu-rental/config');
const provider = require('../../src/utils/gpu-rental/provider');
const svc = require('../../src/utils/gpu-rental/service');
const proxy = require('../../src/terminal/gpu-proxy');
const { MESSAGES } = require('../../src/routes/gpu');

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

function makeRental(over = {}) {
  const r = new GpuRental({
    owner: new mongoose.Types.ObjectId(),
    name: 'ws',
    offerId: 'NVIDIA GeForce RTX 4090',
    gpuName: 'RTX 4090',
    providerServerId: 'pod123',
    status: 'running',
    ready: true,
    pricePerHour: 0.9,
    stoppedPricePerHour: 0.01,
    billedUntil: new Date('2026-01-01T00:00:00Z'),
    ...over,
  });
  r.save = async () => r;
  return r;
}

function stubLedger(balance) {
  stub(WalletTx, 'aggregate', async () => [{ balance }]);
  stub(AffiliateCommission, 'find', () => ({ lean: async () => [] }));
  stub(WalletLock, 'findOneAndUpdate', async () => ({}));
  stub(WalletLock, 'deleteOne', async () => ({}));
  stub(Order, 'find', () => ({ sort: () => ({ lean: async () => [] }) }));
  stub(UsageEvent, 'aggregate', async () => []);
}

describe('gpu pricing', () => {
  const cfg = {
    ...gpuRentalConfig(),
    markup: 0.3,
    minPricePerHour: 0.2,
    storageRunningGbMonth: 0.1,
    storageStoppedGbMonth: 0.2,
  };

  test('ceilCents rounds up to the cent without float noise', () => {
    assert.equal(ceilCents(0.897), 0.9);
    assert.equal(ceilCents(0.9), 0.9);
    assert.equal(ceilCents(1.1 * 3), 3.3);
  });

  test('applies markup to GPU + running storage, stopped price covers volume only', () => {
    const q = quote({ costPerHour: 0.69, gpuCount: 1, diskGb: 20, volumeGb: 20 }, cfg);
    // (0.69 + 40*0.1/730) * 1.3 = 0.9041… -> 0.91
    assert.equal(q.pricePerHour, 0.91);
    // 20*0.2/730*1.3 = 0.0071… -> 0.01
    assert.equal(q.stoppedPricePerHour, 0.01);
  });

  test('multiplies by gpu count and enforces the floor', () => {
    assert.equal(quote({ costPerHour: 1, gpuCount: 2, diskGb: 0, volumeGb: 0 }, cfg).pricePerHour, 2.6);
    assert.equal(quote({ costPerHour: 0.01, diskGb: 0, volumeGb: 0 }, cfg).pricePerHour, 0.2);
  });

  test('public offer hides upstream cost', () => {
    const o = toOffer({ id: 'X', name: 'RTX 4090', memoryGb: 24, costPerHour: 0.69, stock: 'High' }, cfg);
    assert.deepEqual(Object.keys(o).sort(), ['availability', 'clouds', 'id', 'memoryGb', 'name', 'pricePerHour', 'pricePerMinute']);
    assert.equal(o.availability, 'high');
    assert.ok(!JSON.stringify(o).includes('0.69'));
  });
});

describe('gpu accrual', () => {
  const t0 = new Date('2026-01-01T00:00:00Z');

  test('charges whole minutes, carries sub-cent remainder', () => {
    const a = svc.accrue({ billedUntil: t0, carry: 0 }, 0.9, new Date(t0.getTime() + 90_500));
    assert.equal(a.minutes, 1);
    assert.equal(a.charge, 0.01);
    assert.ok(Math.abs(a.carry - 0.005) < 1e-9);
    assert.equal(a.to.getTime(), t0.getTime() + 60_000);
  });

  test('no charge under one minute', () => {
    const a = svc.accrue({ billedUntil: t0, carry: 0.004 }, 0.9, new Date(t0.getTime() + 59_000));
    assert.equal(a.minutes, 0);
    assert.equal(a.charge, 0);
    assert.equal(a.carry, 0.004);
  });

  test('an hour at 0.91/h totals 0.91 across minute ticks', () => {
    let state = { billedUntil: t0, carry: 0 };
    let total = 0;
    for (let i = 1; i <= 60; i += 1) {
      const a = svc.accrue(state, 0.91, new Date(t0.getTime() + i * 60_000));
      total += a.charge;
      state = { billedUntil: a.to, carry: a.carry };
    }
    assert.equal(Math.round(total * 100) / 100, 0.91);
  });
});

describe('gpu settle + balance enforcement', () => {
  let debits;
  let notes;
  beforeEach(() => {
    debits = [];
    notes = [];
    stub(WalletTx, 'create', async (doc) => {
      debits.push(doc);
      return doc;
    });
    stub(Notification, 'create', async (doc) => {
      notes.push(doc);
      return doc;
    });
    stubLedger(100);
    stub(GpuRental, 'findOneAndUpdate', async (q, u) => ({
      billedUntil: u.$set.billedUntil,
      carry: u.$set.carry,
      billedMinutes: u.$inc.billedMinutes,
      billedTotal: u.$inc.billedTotal,
    }));
  });
  afterEach(restoreAll);

  test('settle writes one gpu-rental debit and advances the cursor', async () => {
    const r = makeRental({ pricePerHour: 1.2 });
    const charged = await svc.settle(r, new Date(r.billedUntil.getTime() + 10 * 60_000));
    assert.equal(charged, 0.2);
    assert.equal(debits.length, 1);
    assert.equal(debits[0].type, 'debit');
    assert.equal(debits[0].meta.channel, 'gpu-rental');
    assert.equal(debits[0].meta.minutes, 10);
    assert.doesNotMatch(debits[0].note, /runpod/i);
  });

  test('settle is a no-op when another worker already moved the cursor', async () => {
    stub(GpuRental, 'findOneAndUpdate', async () => null);
    const r = makeRental();
    const charged = await svc.settle(r, new Date(r.billedUntil.getTime() + 5 * 60_000));
    assert.equal(charged, 0);
    assert.equal(debits.length, 0);
  });

  test('warns once when balance covers fewer than warnMinutes', async () => {
    stubLedger(0.1);
    const r = makeRental({ pricePerHour: 0.9 });
    assert.equal(await svc.enforceBalance(r), 'ok');
    assert.equal(await svc.enforceBalance(r), 'ok');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].key, 'gpu.lowBalance');
  });

  test('stops the pod and schedules termination when funds run out', async () => {
    stubLedger(0);
    let stopped = '';
    stub(provider, 'stopServer', async (id) => {
      stopped = id;
      return { id, status: 'stopped' };
    });
    const r = makeRental();
    assert.equal(await svc.enforceBalance(r), 'stopped');
    assert.equal(stopped, 'pod123');
    assert.equal(r.status, 'stopped');
    assert.equal(r.stoppedReason, 'insufficient_funds');
    assert.ok(r.terminateAfter > new Date());
    assert.equal(notes[0].key, 'gpu.stoppedNoFunds');
  });

  test('terminates after the grace period without top-up', async () => {
    stubLedger(0);
    let terminated = '';
    stub(provider, 'terminateServer', async (id) => {
      terminated = id;
      return { id, status: 'terminated' };
    });
    const r = makeRental({ status: 'stopped', terminateAfter: new Date(Date.now() - 1000) });
    assert.equal(await svc.enforceBalance(r), 'terminated');
    assert.equal(terminated, 'pod123');
    assert.equal(r.status, 'terminated');
    assert.equal(notes[0].key, 'gpu.terminatedNoFunds');
  });

  test('top-up clears the pending termination', async () => {
    stubLedger(5);
    const r = makeRental({ status: 'stopped', terminateAfter: new Date(Date.now() + 1000) });
    assert.equal(await svc.enforceBalance(r), 'ok');
    assert.equal(r.terminateAfter, null);
  });
});

describe('gpu rental serialization', () => {
  test('public rental never exposes upstream id, token or cost', () => {
    const r = makeRental({ accessToken: 'secret', costPerHour: 0.69 });
    const json = JSON.stringify(svc.publicRental(r));
    assert.doesNotMatch(json, /pod123|secret|costPerHour|providerServerId|runpod/i);
  });

  test('user-facing error copy is vendor-neutral', () => {
    assert.doesNotMatch(JSON.stringify(MESSAGES), /runpod/i);
  });

  test('pod start command scrubs vendor env and pins jupyter base url', () => {
    const cmd = svc.buildDockerArgs('abc');
    assert.match(cmd, /unset "\$v"/);
    assert.match(cmd, /RUNPOD_/);
    assert.match(cmd, /--ServerApp\.base_url=\/v1\/gpu\/rentals\/abc\/jupyter\//);
    assert.doesNotMatch(cmd, /'[^']*'[^']*'/, 'no nested single quotes inside bash -c');
  });
});

describe('gpu workspace proxy helpers', () => {
  test('strips the ticket but keeps other query params', () => {
    assert.equal(proxy.stripTicket('/v1/gpu/rentals/x/jupyter/lab?ticket=abc&a=1'), '/v1/gpu/rentals/x/jupyter/lab?a=1');
  });

  test('rewrites absolute upstream redirects to relative paths', () => {
    const target = { host: 'pod123-8888.proxy.runpod.net' };
    assert.equal(
      proxy.rewriteLocation('https://pod123-8888.proxy.runpod.net/v1/gpu/rentals/x/jupyter/lab', target),
      '/v1/gpu/rentals/x/jupyter/lab'
    );
    assert.equal(proxy.rewriteLocation('/v1/gpu/rentals/x/jupyter/tree', target), '/v1/gpu/rentals/x/jupyter/tree');
  });

  test('drops vendor-identifying response headers', () => {
    for (const h of ['set-cookie', 'server', 'cf-ray', 'x-runpod-request', 'nel', 'report-to']) {
      assert.equal(proxy.dropResponseHeader(h), true, h);
    }
    assert.equal(proxy.dropResponseHeader('content-type'), false);
  });

  test('session cookie is HttpOnly, path-scoped and rental-bound', () => {
    const rid = 'a'.repeat(24);
    const cookie = proxy.sessionCookie(rid, 'u1');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, new RegExp(`Path=/v1/gpu/rentals/${rid}/jupyter;`));
    const token = decodeURIComponent(cookie.split(';')[0].split('=')[1]);
    const p = jwt.verify(token, config.jwtSecret);
    assert.equal(p.typ, 'gpu-session');
    assert.equal(p.rid, rid);
  });

  test('terminal ticket is single-use and bound to rental + terminal name', () => {
    const rid = 'b'.repeat(24);
    const ws = `/v1/gpu/rentals/${rid}/jupyter/terminals/websocket/3`;
    const t1 = proxy.termTicket(rid, 'u1', '3');
    assert.equal(proxy.termTicketAuth(`${ws}?ticket=${encodeURIComponent(t1)}`, 'c'.repeat(24)), null, 'other rental');
    const t2 = proxy.termTicket(rid, 'u1', '3');
    assert.equal(proxy.termTicketAuth(`/v1/gpu/rentals/${rid}/jupyter/terminals/websocket/4?ticket=${t2}`, rid), null, 'other terminal');
    const t3 = proxy.termTicket(rid, 'u1', '3');
    assert.equal(proxy.termTicketAuth(`/v1/gpu/rentals/${rid}/jupyter/api/kernels?ticket=${t3}`, rid), null, 'non-terminal path');
    const ok = proxy.termTicket(rid, 'u1', '3');
    const p = proxy.termTicketAuth(`${ws}?ticket=${encodeURIComponent(ok)}`, rid);
    assert.equal(p && p.uid, 'u1');
    assert.equal(proxy.termTicketAuth(`${ws}?ticket=${encodeURIComponent(ok)}`, rid), null, 'replay rejected');
    const session = jwt.sign({ typ: 'gpu-ticket', rid, uid: 'u1', term: '3', jti: 'x' }, config.jwtSecret);
    assert.equal(proxy.termTicketAuth(`${ws}?ticket=${session}`, rid), null, 'wrong typ');
    assert.equal(proxy.stripTicket(`${ws}?ticket=abc`), ws);
  });
});

describe('gpu provider errors', () => {
  test('unknown upstream messages collapse to PROVIDER_ERROR', () => {
    const e = provider.providerError(500, 'RunPod said: something');
    assert.equal(e.code, 'PROVIDER_ERROR');
    assert.equal(e.message, 'PROVIDER_ERROR');
  });

  test('known codes keep their status', () => {
    assert.equal(provider.providerError(404, 'SERVER_NOT_FOUND').status, 404);
    assert.equal(provider.providerError(502, 'GPU_UNAVAILABLE').status, 409);
  });
});

describe('training jobs follow their billed workspace', () => {
  const { jobStatus } = require('../../src/routes/training-jobs');

  test('rental lifecycle maps onto job status', () => {
    assert.equal(jobStatus({ status: 'creating' }, 'queued'), 'queued');
    assert.equal(jobStatus({ status: 'running' }, 'queued'), 'running');
    assert.equal(jobStatus({ status: 'stopped' }, 'running'), 'paused');
    assert.equal(jobStatus({ status: 'error' }, 'running'), 'failed');
    assert.equal(jobStatus(null, 'queued'), 'queued');
  });

  test('terminated workspaces end the job; running out of money is a failure', () => {
    assert.equal(jobStatus({ status: 'terminated', stoppedReason: 'insufficient_funds' }, 'paused'), 'failed');
    assert.equal(jobStatus({ status: 'terminated', stoppedReason: 'user' }, 'running'), 'cancelled');
    assert.equal(jobStatus({ status: 'terminated' }, 'succeeded'), 'succeeded');
  });
});

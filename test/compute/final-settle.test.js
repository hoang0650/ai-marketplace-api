const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { installFakeLedger, restoreStubs } = require('../helpers/fake-ledger');
const GameSession = require('../../src/models/GameSession');
const GpuRental = require('../../src/models/GpuRental');
const billing = require('../../src/utils/game-billing');
const svc = require('../../src/utils/gpu-rental/service');

const t0 = new Date('2026-01-01T00:00:00Z');
const oid = () => new mongoose.Types.ObjectId();

let saved;
let db;
beforeEach(() => {
  saved = [];
  db = installFakeLedger({ saved });
});
afterEach(() => restoreStubs(saved));
const stub = (obj, key, fn) => {
  saved.push([obj, key, obj[key]]);
  obj[key] = fn;
};

/** Minimal CAS store for one document. */
function casStore(model, doc, { cursor, onFirstCas } = {}) {
  const row = { ...doc };
  let calls = 0;
  stub(model, 'findOneAndUpdate', async (q, u) => {
    calls += 1;
    if (calls === 1 && onFirstCas) onFirstCas(row);
    if (new Date(row[cursor]).getTime() !== new Date(q[cursor]).getTime()) return null;
    Object.assign(row, u.$set);
    for (const [k, v] of Object.entries(u.$inc || {})) row[k] = (row[k] || 0) + v;
    return { ...row };
  });
  stub(model, 'findById', () => ({ lean: async () => ({ ...row }) }));
  return row;
}

describe('game sessions: final settle', () => {
  const product = { _id: oid(), name: '[TEST] game', category: 'game-server', creator: oid(), ownershipType: 'PLATFORM_DIRECT', pricing: { model: 'usage', currency: 'USD', usageUnit: 'phút', usageRate: 0.0125 } };
  const session = (over = {}) => ({ _id: oid(), sessionId: 'gs_t', user: oid(), status: 'live', billingStartedAt: t0, billedUntil: t0, billingCarry: 0, billedCost: 0, billedMinutes: 0, ...over });

  test('final: partial minute billed and sub-cent carry rounded up (no unbilled tail)', () => {
    const tick = billing.accrue({ from: t0, carry: 0 }, 0.75, new Date(t0.getTime() + 60_000));
    assert.equal(tick.charge, 0.01);
    assert.equal(tick.carry, 0.0025);
    const fin = billing.accrue({ from: tick.to, carry: tick.carry }, 0.75, new Date(tick.to.getTime() + 20_000), { final: true });
    assert.equal(fin.minutes, 1);
    assert.equal(fin.charge, 0.02); // 0.0125 + 0.0025 carry → rounded up
    assert.equal(fin.carry, 0);
    const carryOnly = billing.accrue({ from: t0, carry: 0.004 }, 0.75, t0, { final: true });
    assert.equal(carryOnly.charge, 0.01);
    assert.equal(carryOnly.carry, 0);
  });

  test('stop racing a tick: final settle reloads and bills the remaining tail', async () => {
    const s = session({ user: oid() });
    db.fund(s.user, 5);
    // A concurrent tick moved the cursor to +5 min before our CAS landed.
    casStore(GameSession, s, { cursor: 'billedUntil', onFirstCas: (row) => { row.billedUntil = new Date(t0.getTime() + 5 * 60_000); row.billedMinutes = 5; } });
    const charged = await billing.settleSession(s, product, new Date(t0.getTime() + 7 * 60_000 + 10_000), { final: true });
    assert.equal(charged, 0.04); // 3 min (2m10s rounded up) × 0.0125 = 0.0375 → 0.04
    assert.equal(s.billedUntil.getTime(), t0.getTime() + 8 * 60_000);
    assert.equal(db.balanceOf(s.user), 4.96);
  });

  test('tick that loses the CAS still bills nothing twice', async () => {
    const s = session({ user: oid() });
    db.fund(s.user, 5);
    casStore(GameSession, s, { cursor: 'billedUntil', onFirstCas: (row) => { row.billedUntil = new Date(t0.getTime() + 60_000); } });
    assert.equal(await billing.settleSession(s, product, new Date(t0.getTime() + 2 * 60_000)), 0);
    assert.equal(db.balanceOf(s.user), 5);
  });

  test('buyer short on funds: charge capped, wallet never negative, shortfall recorded', async () => {
    const s = session({ user: oid() });
    db.fund(s.user, 0.03);
    casStore(GameSession, s, { cursor: 'billedUntil' });
    await billing.settleSession(s, product, new Date(t0.getTime() + 10 * 60_000), { final: true });
    assert.equal(db.balanceOf(s.user), 0);
    assert.equal(db.events.at(-1).cost, 0.03);
    assert.ok(db.events.at(-1).rawUsage.shortfall > 0);
  });
});

describe('GPU rentals: final settle', () => {
  const rental = (over = {}) => ({ _id: oid(), owner: oid(), name: '[TEST] gpu', status: 'running', pricePerHour: 0.9, stoppedPricePerHour: 0.01, billedUntil: t0, carry: 0, billedMinutes: 0, billedTotal: 0, ...over });

  test('final settle bills the last partial minute (was dropped)', () => {
    const tick = svc.accrue({ billedUntil: t0, carry: 0 }, 0.9, new Date(t0.getTime() + 90_000));
    assert.equal(tick.minutes, 1);
    const fin = svc.accrue({ billedUntil: t0, carry: 0 }, 0.9, new Date(t0.getTime() + 90_000), { final: true });
    assert.equal(fin.minutes, 2);
    assert.equal(fin.charge, 0.03);
    assert.equal(fin.carry, 0);
  });

  test('terminate racing a tick: final settle retries the CAS and bills the tail', async () => {
    const r = rental();
    db.fund(r.owner, 1);
    casStore(GpuRental, r, { cursor: 'billedUntil', onFirstCas: (row) => { row.billedUntil = new Date(t0.getTime() + 2 * 60_000); } });
    const charged = await svc.settle(r, new Date(t0.getTime() + 3 * 60_000 + 1000), { final: true });
    assert.equal(charged, 0.03); // 2 minutes (1m01s rounded up) × 0.015
    assert.equal(db.balanceOf(r.owner), 0.97);
  });

  test('debit is capped at the spendable balance (never negative)', async () => {
    const r = rental();
    db.fund(r.owner, 0.05);
    casStore(GpuRental, r, { cursor: 'billedUntil' });
    await svc.settle(r, new Date(t0.getTime() + 60 * 60_000));
    assert.equal(db.balanceOf(r.owner), 0);
    const debit = db.tx.find((t) => t.type === 'debit');
    assert.equal(debit.amount, 0.05);
    assert.equal(debit.meta.shortfall, 0.85);
  });
});

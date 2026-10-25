'use strict';

/**
 * In-memory stand-ins for the Mongo models the wallet / metering code touches, with just
 * enough query semantics (equality, dotted paths, $lt/$gt/$in, unique keys) and an event-loop
 * yield on every call so parallel requests genuinely interleave.
 */
const mongoose = require('mongoose');
const WalletTx = require('../../src/models/WalletTx');
const WalletLock = require('../../src/models/WalletLock');
const IdempotencyClaim = require('../../src/models/IdempotencyClaim');
const Order = require('../../src/models/Order');
const UsageEvent = require('../../src/models/UsageEvent');
const UsageStat = require('../../src/models/UsageStat');
const AffiliateCommission = require('../../src/models/AffiliateCommission');
const SellerTaxProfile = require('../../src/models/SellerTaxProfile');
const SellerProfile = require('../../src/models/SellerProfile');

const tick = () => new Promise((r) => setImmediate(r));
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function get(doc, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
}
function eq(a, b) {
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  return String(a) === String(b);
}
function matches(doc, q = {}) {
  return Object.entries(q).every(([k, cond]) => {
    const v = get(doc, k);
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !mongoose.isValidObjectId(cond)) {
      return Object.entries(cond).every(([op, x]) => {
        if (op === '$lt') return v != null && new Date(v) < new Date(x);
        if (op === '$gt') return v != null && v > x;
        if (op === '$gte') return v != null && v >= x;
        if (op === '$in') return x.some((y) => eq(v ?? 'completed', y));
        if (op === '$ne') return !eq(v, x);
        return false;
      });
    }
    if (cond === null) return v == null;
    return v !== undefined && eq(v, cond);
  });
}
const chain = (v) => ({ sort: () => chain(v), select: () => chain(v), limit: () => chain(v), lean: async () => v, then: (r, j) => Promise.resolve(v).then(r, j) });

function installFakeLedger({ saved }) {
  const stub = (obj, key, fn) => {
    saved.push([obj, key, obj[key]]);
    obj[key] = fn;
  };
  const db = { tx: [], locks: new Map(), claims: [], events: [], lockWaits: 0 };

  stub(WalletTx, 'create', async (doc) => {
    await tick();
    const row = { _id: new mongoose.Types.ObjectId(), status: 'completed', createdAt: new Date(), ...clone(doc) };
    row.user = String(doc.user);
    db.tx.push(row);
    return { ...row };
  });
  stub(WalletTx, 'aggregate', async (pipeline) => {
    await tick();
    const user = String(pipeline?.[0]?.$match?.user);
    let balance = 0;
    for (const t of db.tx.filter((r) => r.user === user)) {
      const st = t.status || 'completed';
      if (['credit', 'deposit'].includes(t.type) && st === 'completed') balance += t.amount;
      if (['debit', 'withdraw'].includes(t.type) && ['completed', 'pending'].includes(st)) balance -= t.amount;
    }
    return [{ balance }];
  });
  stub(WalletTx, 'findOne', (q) => chain(clone(db.tx.find((r) => matches(r, q))) || null));
  stub(WalletTx, 'findOneAndUpdate', async (q, u) => {
    await tick();
    const row = db.tx.find((r) => matches(r, q));
    if (!row) return null;
    Object.assign(row, clone(u.$set || {}));
    return { ...row };
  });
  stub(WalletTx, 'deleteOne', async (q) => {
    await tick();
    const i = db.tx.findIndex((r) => matches(r, q));
    if (i >= 0) db.tx.splice(i, 1);
    return { deletedCount: i >= 0 ? 1 : 0 };
  });
  stub(WalletTx, 'updateMany', async (q, u) => {
    await tick();
    const rows = db.tx.filter((r) => matches(r, q));
    rows.forEach((r) => Object.assign(r, clone(u.$set || {})));
    return { modifiedCount: rows.length };
  });

  stub(WalletLock, 'findOneAndUpdate', async (q, u) => {
    await tick();
    const cur = db.locks.get(q._id);
    if (cur && cur.until >= new Date()) {
      db.lockWaits += 1;
      const err = new Error('E11000 duplicate key');
      err.code = 11000;
      throw err;
    }
    const row = { _id: q._id, ...u.$set };
    db.locks.set(q._id, row);
    return row;
  });
  stub(WalletLock, 'deleteOne', async (q) => {
    await tick();
    const cur = db.locks.get(q._id);
    if (cur && cur.token === q.token) db.locks.delete(q._id);
    return {};
  });

  stub(IdempotencyClaim, 'create', async (doc) => {
    await tick();
    if (db.claims.some((c) => eq(c.buyer, doc.buyer) && c.scope === doc.scope && c.key === doc.key)) {
      const err = new Error('E11000 duplicate key');
      err.code = 11000;
      throw err;
    }
    const row = { _id: new mongoose.Types.ObjectId(), createdAt: new Date(), status: 'pending', ...doc, buyer: String(doc.buyer) };
    db.claims.push(row);
    return { ...row };
  });
  stub(IdempotencyClaim, 'findOne', (q) => chain(clone(db.claims.find((c) => matches(c, q))) || null));
  stub(IdempotencyClaim, 'updateOne', async (q, u) => {
    await tick();
    const row = db.claims.find((c) => matches(c, q));
    if (row) Object.assign(row, clone(u.$set || {}));
    return {};
  });
  stub(IdempotencyClaim, 'findOneAndUpdate', async (q, u) => {
    await tick();
    const row = db.claims.find((c) => matches(c, q));
    if (!row) return null;
    Object.assign(row, u.$set || {});
    return { ...row };
  });
  stub(IdempotencyClaim, 'deleteOne', async (q) => {
    await tick();
    const i = db.claims.findIndex((c) => matches(c, q));
    if (i >= 0) db.claims.splice(i, 1);
    return {};
  });

  stub(Order, 'find', () => chain([]));
  stub(UsageEvent, 'aggregate', async () => []);
  stub(UsageEvent, 'create', async (doc) => {
    await tick();
    const row = { _id: new mongoose.Types.ObjectId(), ...doc };
    row.id = String(row._id);
    db.events.push(row);
    return row;
  });
  stub(UsageEvent, 'findOne', async () => null);
  stub(UsageStat, 'updateOne', async () => ({}));
  stub(AffiliateCommission, 'find', () => chain([]));
  stub(SellerTaxProfile, 'findOne', () => chain(null));
  stub(SellerProfile, 'findOne', () => chain(null));

  db.balanceOf = (user) => {
    let b = 0;
    for (const t of db.tx.filter((r) => r.user === String(user))) {
      const st = t.status || 'completed';
      if (['credit', 'deposit'].includes(t.type) && st === 'completed') b += t.amount;
      if (['debit', 'withdraw'].includes(t.type) && ['completed', 'pending'].includes(st)) b -= t.amount;
    }
    return Math.round(b * 1e6) / 1e6;
  };
  db.fund = (user, amount) => db.tx.push({ _id: new mongoose.Types.ObjectId(), user: String(user), type: 'credit', amount, status: 'completed', createdAt: new Date() });
  return db;
}

function restoreStubs(saved) {
  while (saved.length) {
    const [obj, key, orig] = saved.pop();
    obj[key] = orig;
  }
}

module.exports = { installFakeLedger, restoreStubs, matches };

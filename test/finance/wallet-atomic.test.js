const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { installFakeLedger, restoreStubs } = require('../helpers/fake-ledger');
const { placeHold, releaseHold, getSpendableBalance, sweepStaleHolds } = require('../../src/utils/wallet');
const { withWalletLock, acquireWalletLock } = require('../../src/utils/wallet-lock');
const { chargeUsage } = require('../../src/finance/charge-usage');
const { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } = require('../../src/utils/idempotency');

const oid = () => String(new mongoose.Types.ObjectId());
const product = { _id: oid(), name: '[TEST] usage', ownershipType: 'THIRD_PARTY_SELLER', category: 'inference' };

let saved;
let db;
beforeEach(() => {
  saved = [];
  db = installFakeLedger({ saved });
});
afterEach(() => restoreStubs(saved));

describe('wallet lock', () => {
  test('serializes critical sections for the same user', async () => {
    const user = oid();
    let inside = 0;
    let maxInside = 0;
    await Promise.all(Array.from({ length: 6 }, () => withWalletLock(user, async () => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await new Promise((r) => setTimeout(r, 5));
      inside -= 1;
    })));
    assert.equal(maxInside, 1);
    assert.ok(db.lockWaits > 0);
    assert.equal(db.locks.size, 0, 'released after use');
  });

  test('gives up with 503 WALLET_BUSY when the lock is never freed', async () => {
    const user = oid();
    await acquireWalletLock(user);
    await assert.rejects(acquireWalletLock(user, { waitMs: 60 }), { status: 503, code: 'WALLET_BUSY' });
  });
});

describe('holds', () => {
  test('placeHold returns 402 when available < amount (equal amount is allowed)', async () => {
    const user = oid();
    db.fund(user, 1);
    await assert.rejects(placeHold(user, 1.000001), { status: 402 });
    const hold = await placeHold(user, 1);
    assert.equal(hold.status, 'pending');
    assert.equal(await getSpendableBalance(user), 0);
    await releaseHold(hold);
    assert.equal(await getSpendableBalance(user), 1);
  });

  test('parallel holds can never reserve more than the wallet holds', async () => {
    const user = oid();
    db.fund(user, 1);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => placeHold(user, 0.3)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 402));
    assert.ok(db.balanceOf(user) >= 0);
    assert.equal(db.balanceOf(user), 0.1);
  });

  test('stale holds left by a crashed request are swept', async () => {
    const user = oid();
    db.fund(user, 1);
    const hold = await placeHold(user, 1);
    db.tx.find((t) => String(t._id) === String(hold._id)).createdAt = new Date(Date.now() - 60 * 60_000);
    assert.equal(await sweepStaleHolds(user), 1);
    assert.equal(await getSpendableBalance(user), 1);
  });
});

describe('chargeUsage', () => {
  test('finalizes the hold in place (one debit row, actual cost)', async () => {
    const buyer = oid();
    const seller = oid();
    db.fund(buyer, 2);
    const hold = await placeHold(buyer, 0.5);
    const out = await chargeUsage({ buyerId: buyer, sellerId: seller, product, cost: 0.2, holdId: hold._id, funds: 'cap', sellerTaxProfile: { sellerType: 'INDIVIDUAL' } });
    assert.equal(out.charged, 0.2);
    const debits = db.tx.filter((t) => t.user === buyer && t.type === 'debit');
    assert.equal(debits.length, 1);
    assert.equal(debits[0].status, 'completed');
    assert.equal(debits[0].meta.kind, 'usage');
    assert.equal(debits[0].meta.reservedAmount, 0.5);
    assert.equal(db.balanceOf(buyer), 1.8);
    assert.ok(db.balanceOf(seller) > 0 && db.balanceOf(seller) < 0.2);
  });

  test("funds:'require' throws 402 and writes nothing", async () => {
    const buyer = oid();
    db.fund(buyer, 0.1);
    await assert.rejects(
      chargeUsage({ buyerId: buyer, sellerId: oid(), product, cost: 0.5, funds: 'require', sellerTaxProfile: { sellerType: 'INDIVIDUAL' } }),
      { status: 402, code: 'INSUFFICIENT_WALLET' }
    );
    assert.equal(db.balanceOf(buyer), 0.1);
  });

  test("funds:'cap' bills at most the balance and reports the shortfall (never negative)", async () => {
    const buyer = oid();
    db.fund(buyer, 0.3);
    const out = await chargeUsage({ buyerId: buyer, sellerId: oid(), product, cost: 0.5, funds: 'cap', sellerTaxProfile: { sellerType: 'INDIVIDUAL' } });
    assert.ok(out.charged <= 0.3 && out.charged > 0.29);
    assert.equal(out.shortfall, 0.2);
    assert.ok(db.balanceOf(buyer) >= 0);
    const empty = await chargeUsage({ buyerId: buyer, sellerId: oid(), product, cost: 0.5, funds: 'cap', sellerTaxProfile: { sellerType: 'INDIVIDUAL' } });
    if (db.balanceOf(buyer) === 0) assert.equal(empty.skipped, true);
    assert.ok(db.balanceOf(buyer) >= 0);
  });

  test('parallel capped charges never drive the ledger negative', async () => {
    const buyer = oid();
    db.fund(buyer, 1);
    await Promise.all(Array.from({ length: 8 }, () => chargeUsage({ buyerId: buyer, sellerId: oid(), product, cost: 0.3, funds: 'cap', sellerTaxProfile: { sellerType: 'INDIVIDUAL' } })));
    assert.ok(db.balanceOf(buyer) >= 0);
    assert.ok(db.balanceOf(buyer) < 0.000001 + 1e-9);
  });

  test('zero cost / self use releases the hold without a debit', async () => {
    const buyer = oid();
    db.fund(buyer, 1);
    const hold = await placeHold(buyer, 0.4);
    const out = await chargeUsage({ buyerId: buyer, sellerId: oid(), product, cost: 0, holdId: hold._id, funds: 'cap' });
    assert.equal(out.skipped, true);
    assert.equal(db.balanceOf(buyer), 1);
  });
});

describe('idempotency claims', () => {
  test('claim → 409 while running → replay when done; scoped per buyer', async () => {
    const a = oid();
    const b = oid();
    const first = await claimIdempotencyKey(a, 'playground', 'k-1');
    assert.equal(first.state, 'new');
    await assert.rejects(claimIdempotencyKey(a, 'playground', 'k-1'), { status: 409, code: 'IDEMPOTENCY_IN_PROGRESS' });
    assert.equal((await claimIdempotencyKey(b, 'playground', 'k-1')).state, 'new', 'other buyer is independent');
    assert.equal((await claimIdempotencyKey(a, 'gateway', 'k-1')).state, 'new', 'other scope is independent');
    await completeIdempotencyKey(first.claim, { output: 'hi', cost: 0.1 });
    const again = await claimIdempotencyKey(a, 'playground', 'k-1');
    assert.equal(again.state, 'replay');
    assert.deepEqual(again.claim.response, { output: 'hi', cost: 0.1 });
  });

  test('parallel requests with one key: exactly one runs', async () => {
    const a = oid();
    const r = await Promise.allSettled(Array.from({ length: 5 }, () => claimIdempotencyKey(a, 'gateway', 'same')));
    assert.equal(r.filter((x) => x.status === 'fulfilled' && x.value.state === 'new').length, 1);
    assert.equal(r.filter((x) => x.status === 'rejected' && x.reason.status === 409).length, 4);
  });

  test('released (failed) claims can be retried; no key → none; stale pending re-claimable', async () => {
    const a = oid();
    const c = await claimIdempotencyKey(a, 'playground', 'retry');
    await releaseIdempotencyKey(c.claim);
    assert.equal((await claimIdempotencyKey(a, 'playground', 'retry')).state, 'new');
    assert.equal((await claimIdempotencyKey(a, 'playground', '   ')).state, 'none');
    db.claims.find((x) => x.key === 'retry').createdAt = new Date(Date.now() - 11 * 60_000);
    assert.equal((await claimIdempotencyKey(a, 'playground', 'retry')).state, 'new');
  });
});

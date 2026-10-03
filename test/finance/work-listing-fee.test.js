const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const WalletTx = require('../../src/models/WalletTx');
const LedgerEntry = require('../../src/models/LedgerEntry');
const Order = require('../../src/models/Order');
const UsageEvent = require('../../src/models/UsageEvent');
const { listingFee, assertCanPayListingFee, chargeListingFee } = require('../../src/finance/work-listing-fee');
const { VND_PER_USD } = require('../../src/finance/payout-policy');

function stubWallet(t, balance) {
  t.mock.method(WalletTx, 'aggregate', async () => [{ balance }]);
  t.mock.method(UsageEvent, 'aggregate', async () => []);
  t.mock.method(Order, 'find', () => ({ sort: () => ({ lean: async () => [] }) }));
}

test('listing fee defaults to 20,000 VND converted to USD', () => {
  const fee = listingFee();
  assert.equal(fee.vnd, 20000);
  assert.equal(fee.currency, 'USD');
  assert.equal(fee.amount, Math.round((20000 / VND_PER_USD) * 100) / 100);
});

test('posting without enough wallet balance is rejected with 402', async (t) => {
  stubWallet(t, 0);
  const user = { _id: new mongoose.Types.ObjectId(), role: 'employer' };
  await assert.rejects(assertCanPayListingFee(user), (err) => err.status === 402 && err.code === 'INSUFFICIENT_WALLET');
});

test('fee is debited from the wallet and booked as platform revenue', async (t) => {
  stubWallet(t, 50);
  const created = [];
  t.mock.method(WalletTx, 'create', async (doc) => created.push(['wallet', doc]));
  t.mock.method(LedgerEntry, 'create', async (doc) => created.push(['ledger', doc]));
  const user = { _id: new mongoose.Types.ObjectId(), role: 'talent' };
  const ok = await assertCanPayListingFee(user);
  assert.equal(ok.charged, true);
  const res = await chargeListingFee(user, { listingType: 'talent', listingId: 'abc', title: 'Dev' });
  assert.equal(res.charged, true);
  const [[k1, tx], [k2, led]] = created;
  assert.equal(k1, 'wallet');
  assert.equal(tx.type, 'debit');
  assert.equal(tx.amount, listingFee().amount);
  assert.equal(tx.meta.kind, 'work_listing_fee');
  assert.equal(k2, 'ledger');
  assert.equal(led.type, 'PLATFORM_REVENUE');
  assert.equal(led.amount, listingFee().amount);
});

test('admins post for free', async (t) => {
  const spy = t.mock.method(WalletTx, 'create', async () => ({}));
  const res = await chargeListingFee({ _id: new mongoose.Types.ObjectId(), role: 'admin' }, { listingType: 'job', listingId: 'x', title: 'y' });
  assert.equal(res.charged, false);
  assert.equal(spy.mock.callCount(), 0);
});

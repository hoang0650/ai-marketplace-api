const test = require('node:test');
const assert = require('node:assert/strict');
const SellerTaxProfile = require('../../src/models/SellerTaxProfile');
const SellerProfile = require('../../src/models/SellerProfile');
const WalletTx = require('../../src/models/WalletTx');
const { chargeUsage, _profileCache } = require('../../src/finance/charge-usage');

const chain = (v) => ({ sort: () => chain(v), select: () => chain(v), lean: async () => v });
const product = { _id: 'p1', name: 'API', productType: 'API', ownershipType: 'THIRD_PARTY_SELLER' };

function stub({ taxProfile = null, sellerType = null }) {
  _profileCache.clear();
  SellerTaxProfile.findOne = () => chain(taxProfile);
  SellerProfile.findOne = () => chain(sellerType ? { sellerType } : null);
  const created = [];
  WalletTx.create = async (d) => { created.push(d); return d; };
  return created;
}

test('usage for a company seller uses the real type: 0% tax (was default individual 7%)', async () => {
  stub({ sellerType: 'enterprise' });
  const r = await chargeUsage({ buyerId: 'b1', sellerId: 's-co', product, cost: 1 });
  assert.equal(r.settlement.taxAmount ?? r.settlement.totalTaxAmount ?? 0, 0);
  assert.equal(r.sellerNet, 0.8);
});

test('usage for an individual seller: 20% fee + 7% tax', async () => {
  stub({ taxProfile: { sellerType: 'INDIVIDUAL', sellerId: 's-ind' } });
  const r = await chargeUsage({ buyerId: 'b1', sellerId: 's-ind', product, cost: 1 });
  assert.equal(r.sellerNet, 0.73);
});

test('explicit sellerTaxProfile from the caller wins', async () => {
  stub({ sellerType: 'INDIVIDUAL' });
  const r = await chargeUsage({ buyerId: 'b1', sellerId: 's-x', product, cost: 1, sellerTaxProfile: { sellerType: 'HOUSEHOLD_BUSINESS' } });
  assert.equal(r.sellerNet, 0.8);
});

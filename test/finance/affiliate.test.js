const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { settleSale } = require('../../src/finance/settlement-engine');
const { reverseSettlement } = require('../../src/finance/refund-service');
const {
  parseAffiliateRate,
  effectiveAffiliateRate,
  calculateAffiliateCommission,
} = require('../../src/finance/affiliate-engine');
const { pickAttribution, isCommissionHeld } = require('../../src/finance/affiliate-service');
const { affiliateConfig, AFFILIATE_MAX_RATE } = require('../../src/config/affiliate');

const RULES = [{ rate: 0.2, status: 'ACTIVE', appliesTo: 'THIRD_PARTY_SELLER' }];
const sale = (extra = {}) =>
  settleSale({
    unitPrice: 1_000_000,
    ownershipType: 'THIRD_PARTY_SELLER',
    commissionRules: RULES,
    product: { category: 'ai-tool' },
    currency: 'VND',
    digits: 0,
    ...extra,
  });

describe('affiliate rate validation', () => {
  test('0–25% accepted, above 25% or negative rejected', () => {
    assert.equal(AFFILIATE_MAX_RATE, 0.25);
    assert.deepEqual(parseAffiliateRate(0.25), { ok: true, rate: 0.25 });
    assert.deepEqual(parseAffiliateRate(0), { ok: true, rate: 0 });
    assert.equal(parseAffiliateRate(0.2501).ok, false);
    assert.equal(parseAffiliateRate(25).ok, false);
    assert.equal(parseAffiliateRate(-0.01).ok, false);
    assert.equal(parseAffiliateRate('abc').ok, false);
    assert.deepEqual(parseAffiliateRate(null, { allowNull: true }), { ok: true, rate: null });
  });

  test('product override wins, null inherits the store default, default is 0', () => {
    assert.equal(effectiveAffiliateRate({ affiliateRate: 0.1 }, { affiliateDefaultRate: 0.2 }), 0.1);
    assert.equal(effectiveAffiliateRate({ affiliateRate: 0 }, { affiliateDefaultRate: 0.2 }), 0);
    assert.equal(effectiveAffiliateRate({ affiliateRate: null }, { affiliateDefaultRate: 0.2 }), 0.2);
    assert.equal(effectiveAffiliateRate({}, null), 0);
    assert.equal(effectiveAffiliateRate({ affiliateRate: 0.9 }, null), 0);
  });
});

describe('settlement with affiliate commission (borne by the seller)', () => {
  test('1,000,000 VND at 25%: fee 200k, tax 80k, affiliate 250k, seller 470k', () => {
    const s = sale({ affiliateRate: 0.25 });
    assert.equal(s.grossAmount, 1_000_000);
    assert.equal(s.commissionAmount, 200_000);
    assert.equal(s.platformRevenueAmount, 200_000);
    assert.equal(s.taxAmount, 80_000);
    assert.equal(s.affiliateRate, 0.25);
    assert.equal(s.affiliateCommissionAmount, 250_000);
    assert.equal(s.sellerNetAmount, 470_000);
  });

  test('no affiliate: unchanged 720k seller net; tax is not reduced by the commission', () => {
    const base = sale();
    const aff = sale({ affiliateRate: 0.1 });
    assert.equal(base.sellerNetAmount, 720_000);
    assert.equal(base.affiliateCommissionAmount, 0);
    assert.equal(aff.taxAmount, base.taxAmount);
    assert.equal(aff.platformRevenueAmount, base.platformRevenueAmount);
    assert.equal(aff.sellerNetAmount, 620_000);
  });

  test('commission is on the price after discount and a rate above 25% is ignored', () => {
    const discounted = sale({ unitPrice: 800_000, affiliateRate: 0.25 });
    assert.equal(discounted.affiliateCommissionAmount, 200_000);
    assert.equal(discounted.sellerNetAmount, 800_000 - 160_000 - 64_000 - 200_000);
    const over = sale({ affiliateRate: 0.5 });
    assert.equal(over.affiliateCommissionAmount, 0);
  });

  test('platform-direct products never pay affiliate from a seller share', () => {
    const s = sale({ ownershipType: 'PLATFORM_DIRECT', affiliateRate: 0.25 });
    assert.equal(s.affiliateCommissionAmount, 0);
    assert.equal(s.sellerNetAmount, 0);
  });

  test('refund reverses affiliate commission proportionally', () => {
    const s = sale({ affiliateRate: 0.25 });
    const half = reverseSettlement(s, 500_000, 0);
    assert.equal(half.affiliateCommissionAmount, 125_000);
    assert.equal(half.sellerNetAmount, 235_000);
  });
});

describe('affiliate PIT withholding (configurable, pending legal review)', () => {
  const cfg = affiliateConfig({});
  test('defaults: 30 days, 10% over 2,000,000 VND', () => {
    assert.equal(cfg.attributionDays, 30);
    assert.equal(cfg.pit.rate, 0.1);
    assert.equal(cfg.pit.thresholdVnd, 2_000_000);
    assert.equal(affiliateConfig({ AFFILIATE_ATTRIBUTION_DAYS: '7' }).attributionDays, 7);
  });
  test('250,000 VND commission: no PIT', () => {
    const c = calculateAffiliateCommission({ baseAmount: 1_000_000, rate: 0.25, currency: 'VND', digits: 0, config: cfg });
    assert.equal(c.amount, 250_000);
    assert.equal(c.pitAmount, 0);
    assert.equal(c.netAmount, 250_000);
  });
  test('2,500,000 VND commission: 10% withheld', () => {
    const c = calculateAffiliateCommission({ baseAmount: 10_000_000, rate: 0.25, currency: 'VND', digits: 0, config: cfg });
    assert.equal(c.pitAmount, 250_000);
    assert.equal(c.netAmount, 2_250_000);
  });
  test('exactly 2,000,000 is not over the threshold; USD converts at the configured rate', () => {
    const at = calculateAffiliateCommission({ baseAmount: 8_000_000, rate: 0.25, currency: 'VND', digits: 0, config: cfg });
    assert.equal(at.pitAmount, 0);
    const usd = calculateAffiliateCommission({ baseAmount: 400, rate: 0.25, currency: 'USD', config: cfg });
    assert.equal(usd.amount, 100);
    assert.equal(usd.pitAmount, 10); // 100 USD × 26,500 > 2,000,000 VND
    const off = calculateAffiliateCommission({
      baseAmount: 10_000_000, rate: 0.25, currency: 'VND', digits: 0,
      config: affiliateConfig({ AFFILIATE_PIT_ENABLED: 'false' }),
    });
    assert.equal(off.pitAmount, 0);
  });
});

describe('last-click attribution', () => {
  const now = new Date('2026-10-12T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const product = { _id: 'p1', creator: 'seller1' };
  const click = (id, affiliate, daysAgo, extra = {}) => ({
    _id: id,
    affiliate,
    scope: 'product',
    product: 'p1',
    seller: 'seller1',
    code: `C-${affiliate}`,
    createdAt: new Date(now.getTime() - daysAgo * day),
    ...extra,
  });

  test('newest valid click wins', () => {
    const r = pickAttribution([click('a', 'aff1', 5), click('b', 'aff2', 1)], { buyerId: 'buyer', product, now, windowDays: 30 });
    assert.equal(r.click._id, 'b');
  });
  test('expired click (outside window) is ignored', () => {
    const r = pickAttribution([click('a', 'aff1', 31)], { buyerId: 'buyer', product, now, windowDays: 30 });
    assert.equal(r.click, null);
    assert.equal(r.rejected[0].reason, 'EXPIRED');
  });
  test('no self-referral: buyer or seller cannot be the affiliate', () => {
    const r = pickAttribution([click('a', 'buyer', 1), click('b', 'seller1', 1)], { buyerId: 'buyer', product, now, windowDays: 30 });
    assert.equal(r.click, null);
    assert.deepEqual(r.rejected.map((x) => x.reason).sort(), ['SELF_REFERRAL_BUYER', 'SELF_REFERRAL_SELLER']);
  });
  test('product links only count for that product; store links for any product of the seller', () => {
    const other = pickAttribution([click('a', 'aff1', 1, { product: 'p2' })], { buyerId: 'buyer', product, now, windowDays: 30 });
    assert.equal(other.click, null);
    const store = pickAttribution([click('s', 'aff1', 1, { scope: 'store', product: null })], { buyerId: 'buyer', product, now, windowDays: 30 });
    assert.equal(store.click._id, 's');
    const otherStore = pickAttribution([click('s', 'aff1', 1, { scope: 'store', product: null, seller: 'x' })], { buyerId: 'buyer', product, now, windowDays: 30 });
    assert.equal(otherStore.click, null);
  });
});

describe('affiliate 48h hold', () => {
  const now = new Date('2026-10-12T12:00:00Z');
  const c = { status: 'active', netAmount: 100, reversedAmount: 0, holdUntil: new Date(now.getTime() + 3600_000) };
  test('held inside the window, released after, held again by an open dispute', () => {
    assert.equal(isCommissionHeld(c, { disputeStatus: 'none' }, now), true);
    assert.equal(isCommissionHeld({ ...c, holdUntil: new Date(now.getTime() - 1) }, { disputeStatus: 'none' }, now), false);
    assert.equal(isCommissionHeld({ ...c, holdUntil: new Date(now.getTime() - 1) }, { disputeStatus: 'open' }, now), true);
    assert.equal(isCommissionHeld({ ...c, status: 'reversed' }, {}, now), false);
  });
});

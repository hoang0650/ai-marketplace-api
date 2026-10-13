const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { settleSale } = require('../../src/finance/settlement-engine');
const { reverseSettlement } = require('../../src/finance/refund-service');
const {
  parseAffiliateRate,
  effectiveAffiliateRate,
  calculateAffiliateCommission,
  quoteAffiliateWithdrawal,
} = require('../../src/finance/affiliate-engine');
const { pickAttribution, isCommissionHeld, computeAffiliateBalance } = require('../../src/finance/affiliate-service');
const { policyFor } = require('../../src/finance/payout-policy');
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
  test('1,000,000 VND individual seller at 25%: fee 200k, tax 70k, affiliate 250k, seller 480k', () => {
    const s = sale({ affiliateRate: 0.25, sellerTaxProfile: { sellerType: 'INDIVIDUAL' } });
    assert.equal(s.grossAmount, 1_000_000);
    assert.equal(s.commissionAmount, 200_000);
    assert.equal(s.platformRevenueAmount, 200_000);
    assert.equal(s.taxAmount, 70_000);
    assert.equal(s.affiliateRate, 0.25);
    assert.equal(s.affiliateCommissionAmount, 250_000);
    assert.equal(s.sellerNetAmount, 480_000);
  });

  test('1,000,000 VND household business / company at 25%: fee 200k, tax 0, affiliate 250k, seller 550k', () => {
    for (const sellerType of ['HOUSEHOLD_BUSINESS', 'COMPANY']) {
      const s = sale({ affiliateRate: 0.25, sellerTaxProfile: { sellerType } });
      assert.equal(s.commissionAmount, 200_000);
      assert.equal(s.taxAmount, 0);
      assert.equal(s.affiliateCommissionAmount, 250_000);
      assert.equal(s.sellerNetAmount, 550_000);
    }
  });

  test('no affiliate: unchanged 730k seller net; tax is not reduced by the commission', () => {
    const base = sale();
    const aff = sale({ affiliateRate: 0.1 });
    assert.equal(base.sellerNetAmount, 730_000);
    assert.equal(base.affiliateCommissionAmount, 0);
    assert.equal(aff.taxAmount, base.taxAmount);
    assert.equal(aff.platformRevenueAmount, base.platformRevenueAmount);
    assert.equal(aff.sellerNetAmount, 630_000);
  });

  test('commission is on the price after discount and a rate above 25% is ignored', () => {
    const discounted = sale({ unitPrice: 800_000, affiliateRate: 0.25 });
    assert.equal(discounted.affiliateCommissionAmount, 200_000);
    assert.equal(discounted.sellerNetAmount, 800_000 - 160_000 - 56_000 - 200_000);
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
    assert.equal(half.sellerNetAmount, 240_000);
  });
});

describe('affiliate PIT at withdrawal: min 2,000,000 VND, 10% per withdrawal, 0% with Mẫu 08/CK-TNCN', () => {
  const cfg = affiliateConfig({});
  const q = (o) => quoteAffiliateWithdrawal({ currency: 'VND', digits: 0, config: cfg, ...o });
  test('defaults: 30 days, 10%, minimum withdrawal 2,000,000 VND', () => {
    assert.equal(cfg.attributionDays, 30);
    assert.equal(cfg.pit.rate, 0.1);
    assert.equal(cfg.pit.minWithdrawVnd, 2_000_000);
    assert.equal(cfg.pit.thresholdVnd, 2_000_000);
    assert.equal(cfg.pit.commitmentExempts, true);
    assert.equal(affiliateConfig({ AFFILIATE_ATTRIBUTION_DAYS: '7' }).attributionDays, 7);
    assert.equal(affiliateConfig({ AFFILIATE_MIN_WITHDRAW_VND: '3000000' }).pit.minWithdrawVnd, 3_000_000);
  });
  test('commissions are credited gross - no PIT at credit time', () => {
    const c = calculateAffiliateCommission({ baseAmount: 10_000_000, rate: 0.25, currency: 'VND', digits: 0, config: cfg });
    assert.equal(c.amount, 2_500_000);
    assert.equal(c.pitAmount, 0);
    assert.equal(c.netAmount, 2_500_000);
    assert.equal(c.pitRule, 'PIT_AT_WITHDRAWAL');
    const zero = calculateAffiliateCommission({ baseAmount: 1_000_000, rate: 0, currency: 'VND', digits: 0, config: cfg });
    assert.equal(zero.pitRule, '');
  });
  test('withdraw 2,500,000 -> PIT 250,000, receive 2,250,000', () => {
    const w = q({ amount: 2_500_000, available: 3_000_000 });
    assert.equal(w.ok, true);
    assert.equal(w.pitAmount, 250_000);
    assert.equal(w.net, 2_250_000);
    assert.equal(w.pitRule, 'VN_PIT_10PCT_AFFILIATE_WITHDRAWAL');
  });
  test('balance below 2,000,000 VND cannot withdraw; amount below 2,000,000 is rejected; exactly 2M is ok', () => {
    assert.equal(q({ amount: 1_500_000, available: 1_999_999 }).code, 'AFFILIATE_MIN_BALANCE');
    assert.equal(q({ amount: 1_999_999, available: 5_000_000 }).code, 'AFFILIATE_MIN_WITHDRAWAL');
    assert.equal(q({ amount: 6_000_000, available: 5_000_000 }).code, 'AFFILIATE_INSUFFICIENT');
    const at = q({ amount: 2_000_000, available: 2_000_000 });
    assert.equal(at.ok, true);
    assert.equal(at.pitAmount, 200_000);
    assert.equal(at.net, 1_800_000);
  });
  test('approved Mẫu 08/CK-TNCN -> 0% PIT (minimum still applies)', () => {
    const w = q({ amount: 2_500_000, available: 2_500_000, pitCommitmentApproved: true });
    assert.equal(w.pitAmount, 0);
    assert.equal(w.net, 2_500_000);
    assert.equal(w.pitRule, 'EXEMPT_CAM_KET_08_CK_TNCN');
    assert.equal(w.pitCommitmentApplied, true);
    assert.equal(q({ amount: 1_000_000, available: 1_000_000, pitCommitmentApproved: true }).code, 'AFFILIATE_MIN_BALANCE');
  });
  test('USD wallet amounts are converted to VND for the minimum; PIT can be disabled', () => {
    const usdCfg = affiliateConfig({ AFFILIATE_VND_PER_USD: '25000' });
    assert.equal(quoteAffiliateWithdrawal({ amount: 70, available: 100, config: usdCfg }).code, 'AFFILIATE_MIN_WITHDRAWAL');
    const ok = quoteAffiliateWithdrawal({ amount: 100, available: 100, config: usdCfg });
    assert.equal(ok.amountVnd, 2_500_000);
    assert.equal(ok.pitAmount, 10);
    assert.equal(ok.net, 90);
    const off = quoteAffiliateWithdrawal({ amount: 2_500_000, available: 2_500_000, currency: 'VND', digits: 0, config: affiliateConfig({ AFFILIATE_PIT_ENABLED: 'false' }) });
    assert.equal(off.pitAmount, 0);
  });
  test('affiliate balance = live commissions - affiliate withdrawals; held commissions not withdrawable', () => {
    const b = computeAffiliateBalance({ earned: 3_000_000, held: 500_000, withdrawn: 1_000_000 });
    assert.equal(b.balance, 2_000_000);
    assert.equal(b.available, 1_500_000);
    assert.equal(computeAffiliateBalance({ earned: 100, held: 0, withdrawn: 200 }).available, 0);
  });
  test('affiliate persona policy: no platform fee, 10% PIT, min 2,000,000 VND; 0% with Mẫu 08', () => {
    const p = policyFor('affiliate');
    assert.equal(p.platformFeeRate, 0);
    assert.equal(p.taxRate, 0.1);
    assert.equal(p.minAmountVnd, 2_000_000);
    assert.equal(p.chargeAtWithdraw, true);
    assert.equal(policyFor('affiliate', { pitCommitmentApproved: true }).taxRate, 0);
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

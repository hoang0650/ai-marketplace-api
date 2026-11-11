const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { settleSale } = require('../../src/finance/settlement-engine');
const { reverseSettlement } = require('../../src/finance/refund-service');
const {
  parseAffiliateRate,
  effectiveAffiliateRate,
  calculateAffiliateCommission,
  quoteAffiliateWithdrawal,
  affiliateCanWithdraw,
  affiliateParticipation,
} = require('../../src/finance/affiliate-engine');
const { pickAttribution, isCommissionHeld, computeAffiliateBalance } = require('../../src/finance/affiliate-service');
const { policyFor, EMPLOYER_MIN_VND } = require('../../src/finance/payout-policy');
const { affiliateConfig, AFFILIATE_MAX_RATE } = require('../../src/config/affiliate');
const { taxConfig } = require('../../src/config/tax');

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

describe('affiliate PIT at withdrawal: no commercial minimum, configured rate, 0% with Mẫu 08/CK-TNCN', () => {
  const cfg = affiliateConfig({});
  const usdCfg = affiliateConfig({ AFFILIATE_VND_PER_USD: '25000', AFFILIATE_MIN_WITHDRAW_VND: '2000000' });
  const q = (o) => quoteAffiliateWithdrawal({ currency: 'VND', digits: 0, config: cfg, ...o });
  const usd = (o) => quoteAffiliateWithdrawal({ currency: 'USD', digits: 2, config: usdCfg, ...o });
  test('defaults: 30 days, configured 10% PIT, no withdrawal minimum', () => {
    assert.equal(cfg.attributionDays, 30);
    assert.equal(cfg.pit.rate, 0.1);
    assert.equal(cfg.pit.enabled, true);
    assert.equal(cfg.pit.minWithdrawVnd, 0);
    assert.equal(cfg.pit.thresholdVnd, 0);
    assert.equal(cfg.pit.commitmentExempts, true);
    assert.equal(affiliateConfig({ AFFILIATE_ATTRIBUTION_DAYS: '7' }).attributionDays, 7);
    assert.equal(affiliateConfig({ AFFILIATE_PIT_RATE: '0.1' }).pit.rate, 0.1);
    const persisted = affiliateConfig({ AFFILIATE_MIN_WITHDRAW_VND: '3000000' });
    assert.equal(persisted.pit.minWithdrawVnd, 0);
    assert.equal(persisted.pit.thresholdVnd, 0);
    assert.equal(persisted.pit.rate, 0.1);
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
    assert.equal(w.minWithdrawVnd, 0);
    assert.equal(w.legalDetermination, 'unresolved');
    assert.equal(w.article50Paragraph2Applied, false);
    assert.equal(w.statutoryRuleApplied, false);
  });
  test('below 2,000,000 VND and exactly 2,000,000 VND are allowed when available', () => {
    const below = q({ amount: 1_500_000, available: 1_999_999 });
    assert.equal(below.ok, true);
    assert.equal(below.code, undefined);
    assert.equal(below.pitAmount, 150_000);
    assert.equal(below.net, 1_350_000);
    assert.notEqual(below.code, 'AFFILIATE_MIN_BALANCE');
    const partial = q({ amount: 1_999_999, available: 5_000_000 });
    assert.equal(partial.ok, true);
    assert.notEqual(partial.code, 'AFFILIATE_MIN_WITHDRAWAL');
    const at = q({ amount: 2_000_000, available: 2_000_000 });
    assert.equal(at.ok, true);
    assert.equal(at.pitAmount, 200_000);
    assert.equal(at.net, 1_800_000);
    const one = q({ amount: 1, available: 1 });
    assert.equal(one.ok, true);
    assert.equal(one.amountVnd, 1);
  });
  test('zero, negative, and non-finite amounts are rejected', () => {
    for (const amount of [0, -1, -1_500_000, -0]) {
      const w = q({ amount, available: 5_000_000 });
      assert.equal(w.ok, false);
      assert.equal(w.code, 'AFFILIATE_AMOUNT_INVALID');
      assert.equal(w.message, 'Affiliate withdrawal amount must be greater than 0.');
    }
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 'nope', null, undefined]) {
      const w = q({ amount, available: 5_000_000 });
      assert.equal(w.ok, false);
      assert.equal(w.code, 'AFFILIATE_AMOUNT_INVALID');
      assert.equal(w.message, 'Affiliate withdrawal amount must be a finite number greater than 0.');
    }
  });
  test('invalid precision is not a commercial minimum', () => {
    const fractional = q({ amount: 1_500_000.5, available: 5_000_000 });
    assert.equal(fractional.ok, false);
    assert.equal(fractional.code, 'AFFILIATE_AMOUNT_PRECISION');
    assert.equal(fractional.message, 'Affiliate withdrawal must be a whole number of VND.');
    const dust = usd({ amount: 0.004, available: 100 });
    assert.equal(dust.ok, false);
    assert.equal(dust.code, 'AFFILIATE_AMOUNT_PRECISION');
    assert.equal(dust.message, 'Affiliate withdrawal amount rounds to 0.00 USD. This is below wallet precision, not a minimum payout.');
    assert.equal(dust.message.includes('2,000,000'), false);
    const cents = usd({ amount: 10.129, available: 100 });
    assert.equal(cents.code, 'AFFILIATE_AMOUNT_PRECISION');
    assert.equal(cents.message, 'Affiliate withdrawal amount must be in USD with at most 2 decimal places.');
    const oneDong = usd({ amount: 0.00004, available: 80 });
    assert.equal(oneDong.code, 'AFFILIATE_AMOUNT_PRECISION');
  });
  test('amount above the available balance is rejected; the full available USD balance is accepted', () => {
    assert.equal(q({ amount: 6_000_000, available: 5_000_000 }).code, 'AFFILIATE_INSUFFICIENT');
    assert.equal(usd({ amount: 80.01, available: 80 }).code, 'AFFILIATE_INSUFFICIENT');
    const full = usd({ amount: 4.01, available: 4.01 });
    assert.equal(full.ok, true);
    assert.equal(full.gross, 4.01);
    assert.equal(full.pitRate, 0.1);
  });
  test('approved Mẫu 08/CK-TNCN -> 0% PIT, including amounts below 2,000,000 VND', () => {
    const w = q({ amount: 2_500_000, available: 2_500_000, pitCommitmentApproved: true });
    assert.equal(w.pitAmount, 0);
    assert.equal(w.net, 2_500_000);
    assert.equal(w.pitRule, 'EXEMPT_CAM_KET_08_CK_TNCN');
    assert.equal(w.pitCommitmentApplied, true);
    const small = q({ amount: 10_000, available: 10_000, pitCommitmentApproved: true });
    assert.equal(small.ok, true);
    assert.equal(small.pitAmount, 0);
    assert.equal(small.net, 10_000);
  });
  test('USD amounts below and at 2,000,000 VND use the configured PIT rate; PIT can be disabled', () => {
    const below = usd({ amount: 40, available: 60 });
    assert.equal(below.ok, true);
    assert.equal(below.amountVnd, 1_000_000);
    assert.equal(below.pitAmount, 4);
    assert.equal(below.net, 36);
    assert.equal(below.minWithdrawVnd, 0);
    const exact = usd({ amount: 80, available: 80 });
    assert.equal(exact.ok, true);
    assert.equal(exact.amountVnd, 2_000_000);
    assert.equal(exact.pitAmount, 8);
    assert.equal(exact.net, 72);
    const cent = usd({ amount: 0.01, available: 0.01 });
    assert.equal(cent.ok, true);
    assert.equal(cent.gross, 0.01);
    assert.equal(cent.pitRate, 0.1);
    assert.equal(cent.pitAmount, 0);
    assert.equal(cent.net, 0.01);
    const fullBalance = usd({ amount: '4.01', available: 4.01 });
    assert.equal(fullBalance.ok, true);
    assert.equal(fullBalance.gross, 4.01);
    const off = quoteAffiliateWithdrawal({
      amount: 2_500_000,
      available: 2_500_000,
      currency: 'VND',
      digits: 0,
      config: affiliateConfig({ AFFILIATE_PIT_ENABLED: 'false', AFFILIATE_MIN_WITHDRAW_VND: '2000000' }),
    });
    assert.equal(off.ok, true);
    assert.equal(off.pitAmount, 0);
    assert.equal(off.pitRate, 0);
  });
  test('a stored 2,000,000 VND minimum does not reject a smaller withdrawal and is not deleted', () => {
    const stale = {
      pit: {
        enabled: true,
        rate: 0.1,
        minWithdrawVnd: 2_000_000,
        thresholdVnd: 2_000_000,
        commitmentExempts: true,
        vndPerUsd: 25000,
      },
    };
    const w = quoteAffiliateWithdrawal({ amount: 40, available: 80, currency: 'USD', digits: 2, config: stale });
    assert.equal(w.ok, true);
    assert.equal(w.minWithdrawVnd, 0);
    assert.equal(w.pitAmount, 4);
    assert.equal(stale.pit.minWithdrawVnd, 2_000_000);
    assert.equal(stale.pit.thresholdVnd, 2_000_000);
    const prev = process.env.AFFILIATE_MIN_WITHDRAW_VND;
    process.env.AFFILIATE_MIN_WITHDRAW_VND = '2000000';
    try {
      const live = affiliateConfig();
      assert.equal(live.pit.minWithdrawVnd, 0);
      assert.equal(live.pit.thresholdVnd, 0);
      assert.equal(process.env.AFFILIATE_MIN_WITHDRAW_VND, '2000000');
      const policy = policyFor('affiliate');
      assert.equal(policy.minAmountVnd, 0);
      assert.equal(policy.minAmount, 0);
      assert.equal(policy.taxRate, 0.1);
    } finally {
      if (prev === undefined) delete process.env.AFFILIATE_MIN_WITHDRAW_VND;
      else process.env.AFFILIATE_MIN_WITHDRAW_VND = prev;
    }
  });
  test('affiliate balance = live commissions - affiliate withdrawals; held commissions not withdrawable', () => {
    const b = computeAffiliateBalance({ earned: 3_000_000, held: 500_000, withdrawn: 1_000_000 });
    assert.equal(b.balance, 2_000_000);
    assert.equal(b.available, 1_500_000);
    assert.equal(computeAffiliateBalance({ earned: 100, held: 0, withdrawn: 200 }).available, 0);
  });
  test('affiliate participation does not mint a code or a downline', () => {
    const existing = affiliateParticipation({ kyc: { status: 'verified' }, affiliateCode: 'AB1234' });
    assert.equal(existing.linkReady, true);
    assert.equal(existing.code, 'AB1234');
    assert.equal(existing.electronicIdentitySatisfied, false);
    assert.equal(existing.codeIssuance, 'closed_pending_electronic_identity');
    assert.equal(existing.multiLevel, false);
    assert.equal(existing.depositToJoin, false);
    const fresh = affiliateParticipation({ kyc: { status: 'verified' }, affiliateCode: '' });
    assert.equal(fresh.code, null);
    assert.equal(fresh.linkReady, false);
    assert.equal(affiliateParticipation({ kyc: { status: 'verified' }, manualTaxReview: { status: 'approved' } }).linkReady, false);
  });
  test('withdrawal.canWithdraw is identity plus a positive eligible balance', () => {
    assert.equal(affiliateCanWithdraw({ available: 40, identityVerified: true }), true);
    assert.equal(affiliateCanWithdraw({ available: 0.01, identityVerified: true }), true);
    assert.equal(affiliateCanWithdraw({ available: 80, identityVerified: false }), false);
    assert.equal(affiliateCanWithdraw({ available: 0, identityVerified: true }), false);
    assert.equal(affiliateCanWithdraw({ available: 0.004, identityVerified: true }), false);
    assert.equal(affiliateCanWithdraw({ available: -10, identityVerified: true }), false);
    assert.equal(affiliateCanWithdraw({ available: Number.NaN, identityVerified: true }), false);
  });
  test('affiliate persona policy: no platform fee, configured PIT, no minimum; seller and employer minimums stay', () => {
    const p = policyFor('affiliate');
    assert.equal(p.platformFeeRate, 0);
    assert.equal(p.taxRate, 0.1);
    assert.equal(p.minAmountVnd, 0);
    assert.equal(p.minAmount, 0);
    assert.equal(p.chargeAtWithdraw, true);
    assert.equal(p.canWithdraw, true);
    assert.equal(policyFor('affiliate', { pitCommitmentApproved: true }).taxRate, 0);
    assert.equal(policyFor('seller', { sellerType: 'INDIVIDUAL', sellerTypeKnown: true }).minAmountVnd, 0);
    assert.equal(policyFor('employer').minAmountVnd, EMPLOYER_MIN_VND);
    if (!process.env.WITHDRAW_EMPLOYER_MIN_VND) assert.equal(EMPLOYER_MIN_VND, 2_000_000);
    assert.equal(taxConfig({}).individual.annualThresholdVnd, 100_000_000);
    assert.equal(
      taxConfig({ AFFILIATE_MIN_WITHDRAW_VND: '2000000' }).individual.annualThresholdVnd,
      100_000_000,
    );
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
  test('a click already tied to another visitor cannot be reused', () => {
    const r = pickAttribution(
      [click('a', 'aff1', 1, { visitor: 'other-buyer' }), click('b', 'aff2', 2)],
      { buyerId: 'buyer', product, now, windowDays: 30 },
    );
    assert.equal(r.click._id, 'b');
    assert.equal(r.rejected[0].reason, 'VISITOR_MISMATCH');
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

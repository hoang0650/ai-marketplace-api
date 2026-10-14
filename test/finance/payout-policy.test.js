const test = require('node:test');
const assert = require('node:assert/strict');

const {
  policyFor,
  quoteWithdrawal,
  vndToUsd,
  EMPLOYER_MIN_VND,
  SELLER_PLATFORM_FEE_RATE,
  SELLER_TAX_RATE,
  EMPLOYER_FEE_RATE,
} = require('../../src/finance/payout-policy');

test('seller/talent/freelancer policy carries 20% platform fee + type-based tax (individual 7% digital)', () => {
  assert.equal(SELLER_TAX_RATE, 0.07);
  for (const persona of ['seller', 'talent', 'freelancer']) {
    const policy = policyFor(persona, { sellerType: 'INDIVIDUAL' });
    assert.equal(policy.canWithdraw, true);
    assert.equal(policy.platformFeeRate, SELLER_PLATFORM_FEE_RATE);
    assert.equal(policy.taxRate, SELLER_TAX_RATE);
    // Charged at source by default (settlement snapshot), so the withdraw quote
    // must not double-charge: gross in = net out.
    const q = quoteWithdrawal(100, policy);
    assert.equal(q.gross, 100);
    assert.equal(q.platformFee, 0);
    assert.equal(q.tax, 0);
    assert.equal(q.net, 100);
    assert.equal(q.chargeAtWithdraw, false);
  }
});

test('quote charges seller rates when chargeAtWithdraw is forced on', () => {
  const policy = { ...policyFor('seller', { sellerType: 'INDIVIDUAL' }), chargeAtWithdraw: true };
  const q = quoteWithdrawal(100, policy);
  assert.equal(q.platformFee, 20);
  assert.equal(q.tax, 7);
  assert.equal(q.net, 73);
  assert.equal(q.totalFee, 27);
});

test('household business / company sellers have no tax in the withdraw policy', () => {
  for (const sellerType of ['HOUSEHOLD_BUSINESS', 'COMPANY', 'household_business', 'enterprise']) {
    const policy = { ...policyFor('seller', { sellerType }), chargeAtWithdraw: true };
    assert.equal(policy.taxRate, 0);
    assert.equal(quoteWithdrawal(100, policy).net, 80);
  }
  assert.equal(policyFor('seller', { sellerType: 'INDIVIDUAL' }).taxRate, 0.07);
});

test('employer pays 1% and needs the VND minimum balance', () => {
  const policy = policyFor('employer');
  assert.equal(policy.platformFeeRate, EMPLOYER_FEE_RATE);
  assert.equal(policy.taxRate, 0);
  assert.equal(policy.minAmountVnd, EMPLOYER_MIN_VND);
  assert.equal(policy.minAmount, vndToUsd(EMPLOYER_MIN_VND));
  const q = quoteWithdrawal(200, policy);
  assert.equal(q.platformFee, 2);
  assert.equal(q.tax, 0);
  assert.equal(q.net, 198);
});

test('buyer may withdraw wallet balance (after eKYC) with no withdrawal fee', () => {
  const policy = policyFor('buyer');
  assert.equal(policy.canWithdraw, true);
  assert.equal(policy.totalFeeRate, 0);
  const q = quoteWithdrawal(50, policy);
  assert.equal(q.net, 50);
});

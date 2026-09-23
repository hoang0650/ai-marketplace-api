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

test('seller/talent/freelancer policy carries 20% platform fee + 8% tax', () => {
  for (const persona of ['seller', 'talent', 'freelancer']) {
    const policy = policyFor(persona);
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
  const policy = { ...policyFor('seller'), chargeAtWithdraw: true };
  const q = quoteWithdrawal(100, policy);
  assert.equal(q.platformFee, 20);
  assert.equal(q.tax, 8);
  assert.equal(q.net, 72);
  assert.equal(q.totalFee, 28);
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

test('buyer cannot withdraw', () => {
  const policy = policyFor('buyer');
  assert.equal(policy.canWithdraw, false);
  assert.equal(policy.totalFeeRate, 0);
});

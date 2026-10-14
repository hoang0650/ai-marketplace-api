const test = require('node:test');
const assert = require('node:assert/strict');
const { policyFor, mapPolicy, quoteWithdrawal } = require('../../src/finance/payout-policy');

test('individual digital seller: 7% tax, 27% total', () => {
  const p = policyFor('seller', { sellerType: 'INDIVIDUAL', sellerTypeKnown: true, productKinds: ['DIGITAL', 'DIGITAL'] });
  assert.equal(p.taxMode, 'single');
  assert.equal(p.taxRate, 0.07);
  assert.equal(p.totalFeeRate, 0.27);
});

test('individual physical-goods seller: 1.5% tax, 21.5% total (not 27%)', () => {
  const p = policyFor('seller', { sellerType: 'INDIVIDUAL', sellerTypeKnown: true, productKinds: ['GOODS'] });
  assert.equal(p.taxRate, 0.015);
  assert.equal(p.totalFeeRate, 0.215);
});

test('household business / company: 0% tax, total = 20% fee', () => {
  for (const sellerType of ['HOUSEHOLD_BUSINESS', 'COMPANY']) {
    const p = policyFor('seller', { sellerType, sellerTypeKnown: true, productKinds: ['DIGITAL', 'GOODS'] });
    assert.equal(p.taxMode, 'none');
    assert.equal(p.taxRate, 0);
    assert.equal(p.totalFeeRate, 0.2);
  }
});

test('mixed digital + goods individual: per-order breakdown, no single rate', () => {
  const p = policyFor('seller', { sellerType: 'INDIVIDUAL', sellerTypeKnown: true, productKinds: ['GOODS', 'DIGITAL'] });
  assert.equal(p.taxMode, 'per_order');
  assert.equal(p.taxRate, null);
  assert.equal(p.totalFeeRate, null);
  assert.deepEqual(p.taxBreakdown, [
    { kind: 'DIGITAL', rate: 0.07, totalFeeRate: 0.27 },
    { kind: 'GOODS', rate: 0.015, totalFeeRate: 0.215 },
  ]);
});

test('undeclared seller type: no 7% assumption, prompt to complete tax profile', () => {
  const p = policyFor('seller', { sellerType: 'INDIVIDUAL', sellerTypeKnown: false });
  assert.equal(p.taxMode, 'unknown');
  assert.equal(p.taxRate, null);
  assert.equal(p.totalFeeRate, null);
  const m = mapPolicy(p);
  assert.equal(m.taxProfileIncomplete, true);
  assert.equal(m.quoteTaxRate, undefined, 'internal quote rate is not exposed');
  // Forced charge-at-withdraw keeps the previous quoting behaviour.
  assert.equal(quoteWithdrawal(100, { ...p, chargeAtWithdraw: true }).tax, 7);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { taxCategoryFromProduct } = require('../../src/finance/tax-category');
const { productTaxKind, sellerTaxRateFor } = require('../../src/finance/seller-tax-policy');
const { normalizeProductKind } = require('../../src/routes/products');

test('productKind drives goods vs digital tax kind', () => {
  assert.equal(productTaxKind(taxCategoryFromProduct({ productKind: 'PHYSICAL', taxCategory: 'AI_API' })), 'GOODS');
  assert.equal(productTaxKind(taxCategoryFromProduct({ productKind: 'DIGITAL', category: 'dataset' })), 'DIGITAL');
  assert.equal(productTaxKind(taxCategoryFromProduct({ productKind: 'DIGITAL', taxCategory: 'PHYSICAL_GOODS' })), 'DIGITAL');
});

test('individual rates: digital 7% (5+2), goods 1.5% (1+0.5); household/company not withheld', () => {
  const d = sellerTaxRateFor('INDIVIDUAL', 'AI_API');
  const g = sellerTaxRateFor('INDIVIDUAL', 'PHYSICAL_GOODS');
  assert.equal(d.total, 0.07);
  assert.equal(g.total, 0.015);
  assert.equal(sellerTaxRateFor('HOUSEHOLD_BUSINESS', 'PHYSICAL_GOODS').total, 0);
  assert.equal(sellerTaxRateFor('COMPANY', 'AI_API').total, 0);
});

test('normalizeProductKind', () => {
  assert.equal(normalizeProductKind('digital'), 'DIGITAL');
  assert.equal(normalizeProductKind('GOODS'), 'PHYSICAL');
  assert.equal(normalizeProductKind(''), '');
  assert.equal(normalizeProductKind('x'), '');
});

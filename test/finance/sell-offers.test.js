const test = require('node:test');
const assert = require('node:assert/strict');
const { platformVoiceProduct, platformVoiceDefs } = require('../../src/data/platform-voices');
const { stampMappedProduct } = require('../../src/finance/vnd-quote');
const { buildSellOffers } = require('../../src/finance/sell-offers');

const fx = { vndPerUsd: 25608.244657, rateSource: 'exchangerate-api' };

test('chatterbox usage rate and the month pass are different offers', () => {
  const def = platformVoiceDefs().find((row) => row.slug === 'giong-san-chatterbox');
  const product = platformVoiceProduct(def);
  const stamped = stampMappedProduct(product, fx);
  const usage = stamped.offers.find((offer) => offer.billingMode === 'usage');
  const month = stamped.offers.find((offer) => offer.unit === '1_month');
  const day = stamped.offers.find((offer) => offer.unit === '1_day');
  const year = stamped.offers.find((offer) => offer.unit === '1_year');
  assert.equal(stamped.listOfferId, usage.id);
  assert.equal(usage.unit, '1k_characters');
  assert.equal(usage.rate, 0.0123);
  assert.equal(usage.rateVnd.amountVnd, 315);
  assert.equal(usage.price, null);
  assert.equal(stamped.pricingVnd.usageRate.amountVnd, usage.rateVnd.amountVnd);
  assert.equal(month.billingMode, 'period');
  assert.equal(month.price, 4.9);
  assert.equal(month.priceVnd.amountVnd, 125480);
  assert.equal(month.rate, null);
  assert.notEqual(month.priceVnd.amountVnd, usage.rateVnd.amountVnd);
  assert.equal(day.price, 0.99);
  assert.equal(year.price, 39);
  assert.equal(stamped.offers.some((offer) => offer.unit === '1_week'), false);
  assert.match(usage.includesVi, /không phải giá thuê/);
  assert.match(month.includesVi, /không phải đơn giá/);
});

test('a promised period without a stored price is needs_review', () => {
  const { offers } = buildSellOffers({
    category: 'voice-preset',
    description: 'Trả theo ký tự hoặc license ngày/tháng/năm.',
    pricing: { model: 'usage', currency: 'USD', usageUnit: '1K characters', usageRate: 0.0123 },
    contentMeta: { charactersPerCredit: 1000, licensePrices: {} },
  }, fx);
  const month = offers.find((offer) => offer.unit === '1_month');
  assert.equal(month.status, 'needs_review');
  assert.equal(month.price, null);
  assert.equal(month.priceVnd, null);
  assert.equal(offers.find((offer) => offer.billingMode === 'usage').rateVnd.amountVnd, 315);
  assert.equal(offers.some((offer) => offer.unit === '1_week'), false);
});

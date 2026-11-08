const test = require('node:test');
const assert = require('node:assert/strict');
const { quoteAuthoritativeVnd, assertClientVndMatches, pricingVnd } = require('../../src/finance/vnd-quote');
const { sectorQualification, DRAFT_SECTORS } = require('../../src/finance/sector-qualification');
const { AI_CATEGORIES } = require('../../src/data/categories');

test('USD converts to an integer VND quote only from a non-fallback server rate', () => {
  const quote = quoteAuthoritativeVnd({ amount: 10, currency: 'USD', vndPerUsd: 25000, rateSource: 'exchangerate-api' });
  assert.equal(quote.authoritative, true);
  assert.equal(Number.isSafeInteger(quote.amountVnd), true);
  assert.equal(quote.amountVnd, 250000);
  assert.equal(quote.ledgerCurrency, 'USD');
  assert.equal(quote.displayOnly, true);
  const fallback = quoteAuthoritativeVnd({ amount: 10, currency: 'USD', vndPerUsd: 26500, rateSource: 'fallback' });
  assert.equal(fallback.authoritative, false);
  assert.equal(fallback.amountVnd, null);
  assert.equal(fallback.code, 'RATE_UNAVAILABLE');
});

test('a client VND figure is accepted only when it equals the server quote', () => {
  const serverQuote = quoteAuthoritativeVnd({ amount: 2, currency: 'USD', vndPerUsd: 25000, rateSource: 'override' });
  assert.equal(assertClientVndMatches({ clientAmountVnd: serverQuote.amountVnd, serverQuote }).ok, true);
  assert.equal(assertClientVndMatches({ serverQuote }).ok, true);
  assert.equal(assertClientVndMatches({ clientAmountVnd: serverQuote.amountVnd + 1, serverQuote }).code, 'VND_PRICE_MISMATCH');
  assert.equal(assertClientVndMatches({ clientAmountVnd: 1, serverQuote: { authoritative: false, code: 'RATE_UNAVAILABLE' } }).code, 'RATE_UNAVAILABLE');
});

test('stored VND stays integer and other currencies fail closed', () => {
  assert.equal(quoteAuthoritativeVnd({ amount: 150000, currency: 'VND' }).amountVnd, 150000);
  assert.equal(quoteAuthoritativeVnd({ amount: 10.5, currency: 'VND' }).code, 'VND_NOT_INTEGER');
  assert.equal(quoteAuthoritativeVnd({ amount: 10, currency: 'CNY', vndPerUsd: 25000, rateSource: 'override' }).code, 'CURRENCY_UNSUPPORTED');
  const priced = pricingVnd({ price: 10, currency: 'USD', usageRate: 0.000001 }, { vndPerUsd: 25000, rateSource: 'override' });
  assert.equal(priced.price.amountVnd, 250000);
  assert.equal(priced.usageRate.authoritative, false);
  assert.equal(priced.clientRateIgnored, true);
});

test('film, books, cloned voice and cloud stay listed and unqualified', () => {
  for (const id of ['ai-film-series', 'story-book', 'voice-clone', 'voice-preset', 'gpu-compute']) {
    assert.equal(AI_CATEGORIES.some((c) => c.id === id), true, id);
    const q = sectorQualification(id);
    assert.equal(q.status, 'draft_unverified');
    assert.equal(q.qualified, false);
    assert.equal(q.evidenceRequired, true);
    assert.equal(q.sector, DRAFT_SECTORS[id]);
  }
  assert.equal(sectorQualification('api-endpoint').status, 'not_applicable');
});

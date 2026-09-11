const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  isLicenseCategory,
  isVoiceCategory,
  isWatchContentCategory,
  normalizeLicenseTerm,
  expiresAtFrom,
  resolveLicensePrice,
  effectiveLicenseStatus,
  generateLicenseKey,
  normalizeContentMeta,
} = require('../../src/utils/license-keys');

describe('license categories', () => {
  test('film, story, skill and dataset issue keys; voice clone does not', () => {
    assert.equal(isLicenseCategory('ai-film-series'), true);
    assert.equal(isLicenseCategory('story-book'), true);
    assert.equal(isLicenseCategory('skill-pack'), true);
    assert.equal(isLicenseCategory('dataset'), true);
    assert.equal(isLicenseCategory('voice-clone'), false);
    assert.equal(isVoiceCategory('voice-clone'), true);
    assert.equal(isWatchContentCategory('ai-film-series'), true);
    assert.equal(isWatchContentCategory('story-book'), true);
    assert.equal(isWatchContentCategory('skill-pack'), false);
  });
});

describe('license terms', () => {
  test('normalizes day/month/year', () => {
    assert.equal(normalizeLicenseTerm('DAY'), 'day');
    assert.equal(normalizeLicenseTerm('week', 'month'), 'month');
  });

  test('expiry is exclusive of start by one term', () => {
    const start = new Date('2026-09-07T00:00:00.000Z');
    assert.equal(expiresAtFrom(start, 'day').toISOString(), '2026-09-08T00:00:00.000Z');
    assert.equal(expiresAtFrom(start, 'month').toISOString(), '2026-10-07T00:00:00.000Z');
    assert.equal(expiresAtFrom(start, 'year').toISOString(), '2027-09-07T00:00:00.000Z');
  });
});

describe('license price snapshot', () => {
  test('buyer term uses catalog map when present', () => {
    const p = {
      pricing: { price: 9, interval: 'month' },
      contentMeta: { licenseTerm: 'month', licensePrices: { day: 2, month: 9, year: 70 } },
    };
    assert.deepEqual(resolveLicensePrice(p, 'day'), { term: 'day', unitPrice: 2 });
    assert.deepEqual(resolveLicensePrice(p, 'year'), { term: 'year', unitPrice: 70 });
  });

  test('missing license prices do not look like a paid unlock', () => {
    const p = { pricing: { price: 0 }, contentMeta: { licensePrices: {} } };
    assert.equal(resolveLicensePrice(p, 'month').unitPrice, 0);
  });
});

describe('status', () => {
  test('expired when now passes expiresAt', () => {
    const doc = { status: 'active', expiresAt: new Date('2026-01-01') };
    assert.equal(effectiveLicenseStatus(doc, new Date('2026-02-01')), 'expired');
    assert.equal(effectiveLicenseStatus({ status: 'revoked', expiresAt: new Date('2027-01-01') }), 'revoked');
  });

  test('key format', () => {
    assert.match(generateLicenseKey(), /^AIM-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
  });
});

describe('license is per product, not per shop', () => {
  test('a key for product A does not cover product B from the same seller', () => {
    const { licenseCoversProduct } = require('../../src/utils/license-keys');
    const shop = '64b000000000000000000099';
    const filmA = '64b0000000000000000000a1';
    const filmB = '64b0000000000000000000a2';
    const keyA = { product: filmA, seller: shop };
    assert.equal(licenseCoversProduct(keyA, filmA), true);
    assert.equal(licenseCoversProduct(keyA, filmB), false);
    assert.equal(licenseCoversProduct({ product: { _id: filmA }, seller: shop }, filmB), false);
  });
});

describe('content meta', () => {
  test('skill and dataset meta kind', () => {
    assert.equal(normalizeContentMeta('skill-pack', { licensePrices: { month: 5 } }).kind, 'skill');
    assert.equal(normalizeContentMeta('dataset', { licensePrices: { year: 20 } }).kind, 'dataset');
  });

  test('voice defaults to TTS', () => {
    const meta = normalizeContentMeta('voice-clone', { voiceModes: ['stt'] });
    assert.equal(meta.kind, 'voice');
    assert.deepEqual(meta.voiceModes, ['stt']);
    assert.equal(meta.charactersPerCredit, 1000);
    assert.equal(meta.cloneStatus, 'pending');
  });

  test('voice clone meta is ready when sample exists', () => {
    const meta = normalizeContentMeta('voice-clone', { voiceSampleUrl: 'https://x/a.mp3' });
    assert.equal(meta.cloneStatus, 'ready');
    assert.equal(meta.cloneEndpoint, 'chatterbox-turbo');
  });
});

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { decodeJwsPayload, looksLikeJws, matchApplePayload } = require('../../src/iap/verify-apple');

describe('Apple IAP payload', () => {
  test('looksLikeJws requires three segments', () => {
    assert.equal(looksLikeJws('a.b.c'), true);
    assert.equal(looksLikeJws('base64receiptwithoutdots'), false);
    assert.equal(looksLikeJws(''), false);
  });

  test('decodeJwsPayload reads the middle segment', () => {
    const payload = Buffer.from(JSON.stringify({ productId: 'aimarkets.wallet.5', bundleId: 'app.phgroup.ai-market-vn' })).toString(
      'base64url',
    );
    assert.deepEqual(decodeJwsPayload(`e30.${payload}.sig`), {
      productId: 'aimarkets.wallet.5',
      bundleId: 'app.phgroup.ai-market-vn',
    });
  });

  test('rejects revoked or wrong bundle / sku / tx', () => {
    assert.equal(
      matchApplePayload({ revocationDate: 1, productId: 'aimarkets.wallet.5', bundleId: 'app.phgroup.ai-market-vn' }, {
        productId: 'aimarkets.wallet.5',
        transactionId: '1',
      }).code,
      'IAP_APPLE_REVOKED',
    );
    assert.equal(
      matchApplePayload({ productId: 'aimarkets.wallet.5', bundleId: 'other.app' }, {
        productId: 'aimarkets.wallet.5',
        transactionId: '1',
      }).code,
      'IAP_APPLE_BUNDLE',
    );
    assert.equal(
      matchApplePayload({ productId: 'aimarkets.wallet.10', bundleId: 'app.phgroup.ai-market-vn', transactionId: '1' }, {
        productId: 'aimarkets.wallet.5',
        transactionId: '1',
      }).code,
      'IAP_APPLE_SKU',
    );
    assert.equal(
      matchApplePayload({ productId: 'aimarkets.wallet.5', bundleId: 'app.phgroup.ai-market-vn', transactionId: '9' }, {
        productId: 'aimarkets.wallet.5',
        transactionId: '1',
      }).code,
      'IAP_APPLE_TX',
    );
  });

  test('accepts a matching consumable transaction', () => {
    const hit = matchApplePayload(
      {
        productId: 'aimarkets.wallet.20',
        bundleId: 'app.phgroup.ai-market-vn',
        transactionId: '1000000123',
        type: 'Consumable',
      },
      { productId: 'aimarkets.wallet.20', transactionId: '1000000123' },
    );
    assert.equal(hit.ok, true);
    assert.equal(hit.transactionId, '1000000123');
  });
});

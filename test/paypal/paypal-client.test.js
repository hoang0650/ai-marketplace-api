const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { toPaypalUsd, paypalBase, SANDBOX_BASE, buildCheckoutOrder } = require('../../src/utils/paypal-client');

describe('PayPal client helpers (phhotel-api Orders v2 pattern)', () => {
  test('converts VND to USD cents and rejects empty amounts', () => {
    assert.equal(toPaypalUsd(26000, 'VND', 26000), '1.00');
    assert.equal(toPaypalUsd(5.5, 'USD'), '5.50');
    assert.equal(toPaypalUsd(0, 'USD'), null);
    assert.equal(toPaypalUsd(100, 'EUR'), null);
  });

  test('sandbox base matches PayPal sandbox host', () => {
    assert.equal(SANDBOX_BASE, 'https://api-m.sandbox.paypal.com');
    assert.match(paypalBase(), /^https:\/\/api-m\.(sandbox\.)?paypal\.com$/);
  });

  test('checkout payload is CAPTURE with USD and return URLs', () => {
    const body = buildCheckoutOrder({
      amountUsd: '4.99',
      customId: '64b000000000000000000001',
      description: 'AI Markets wallet',
    });
    assert.equal(body.intent, 'CAPTURE');
    assert.equal(body.purchase_units[0].amount.currency_code, 'USD');
    assert.equal(body.purchase_units[0].amount.value, '4.99');
    assert.equal(body.application_context.user_action, 'PAY_NOW');
    assert.equal(body.application_context.shipping_preference, 'NO_SHIPPING');
    assert.match(body.application_context.return_url, /paymentMethod=paypal/);
  });
});

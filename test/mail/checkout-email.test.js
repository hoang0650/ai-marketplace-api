const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildCheckoutEmail, escapeHtml } = require('../../src/utils/checkout-email');

describe('checkout email', () => {
  test('includes license key in subject, html, and text', () => {
    const mail = buildCheckoutEmail({
      buyerName: 'Hoàng',
      productName: 'Phim AI tập 1',
      orderId: 'ord_1',
      amount: 9,
      currency: 'USD',
      license: {
        licenseKey: 'AIM-AAAA-BBBB-CCCC-DDDD',
        term: 'month',
        expiresAt: '2026-10-07T00:00:00.000Z',
      },
    });
    assert.match(mail.subject, /AIM-AAAA-BBBB-CCCC-DDDD/);
    assert.match(mail.html, /AIM-AAAA-BBBB-CCCC-DDDD/);
    assert.match(mail.text, /AIM-AAAA-BBBB-CCCC-DDDD/);
    assert.match(mail.text, /1 tháng/);
    assert.equal(mail.hasLicense, true);
  });

  test('omits license block when no key', () => {
    const mail = buildCheckoutEmail({
      buyerName: 'Hoàng',
      productName: 'Voice clone',
      orderId: 'ord_2',
      amount: 2,
      currency: 'USD',
    });
    assert.equal(mail.hasLicense, false);
    assert.doesNotMatch(mail.html, /License key/);
    assert.match(mail.subject, /Thanh toán thành công/);
  });

  test('escapes HTML in product name', () => {
    const mail = buildCheckoutEmail({
      productName: '<script>x</script>',
      orderId: 'ord_3',
      amount: 1,
    });
    assert.match(mail.html, /&lt;script&gt;/);
    assert.doesNotMatch(mail.html, /<script>x<\/script>/);
    assert.equal(escapeHtml('<a>'), '&lt;a&gt;');
  });
});

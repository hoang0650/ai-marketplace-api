const test = require('node:test');
const assert = require('node:assert/strict');

// Regression: billing checkout and milestone sales import issueOrderInvoices. When it went missing
// every paid checkout threw *after* the wallet debit and returned HTTP 500 (money taken, no notice).
test('invoice-service exports everything billing and milestone sales import', () => {
  const svc = require('../../src/finance/invoice-service');
  assert.equal(typeof svc.issueOrderInvoices, 'function');
  assert.equal(typeof svc.ensureOrderInvoice, 'function');
  for (const file of ['../../src/routes/billing.js', '../../src/finance/milestone-sale.js']) {
    const src = require('fs').readFileSync(require.resolve(file), 'utf8');
    for (const m of src.matchAll(/const \{([^}]+)\} = require\('(?:\.\.\/finance|\.)\/invoice-service'\)/g)) {
      for (const name of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
        assert.equal(typeof svc[name], 'function', `${file} imports missing ${name}`);
      }
    }
  }
});

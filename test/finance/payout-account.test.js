const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBankAccount, maskAccountNumber } = require('../../src/utils/payout-account');

test('buyer withdrawal bank account is required and validated', () => {
  assert.equal(parseBankAccount(undefined).code, 'BANK_ACCOUNT_REQUIRED');
  assert.equal(parseBankAccount({ bankName: 'V', accountNumber: '0123456789', accountName: 'A B' }).code, 'INVALID_BANK_NAME');
  assert.equal(parseBankAccount({ bankName: 'Vietcombank', accountNumber: '12ab', accountName: 'A B' }).code, 'INVALID_ACCOUNT_NUMBER');
  assert.equal(parseBankAccount({ bankName: 'Vietcombank', accountNumber: '0123456789', accountName: '' }).code, 'INVALID_ACCOUNT_NAME');
  const ok = parseBankAccount({ bankName: '  Vietcombank ', accountNumber: '0123 456-789', accountName: 'NGUYEN  VAN A' });
  assert.deepEqual(ok, { ok: true, data: { bankName: 'Vietcombank', accountNumber: '0123456789', accountName: 'NGUYEN VAN A' } });
});

test('mask account number', () => {
  assert.equal(maskAccountNumber('0123456789'), '••••••6789');
  assert.equal(maskAccountNumber('1234'), '1234');
});

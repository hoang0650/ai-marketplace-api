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

const { normalizeHolderName, holderMatchesKyc, mapPayoutAccount, hasPayoutAccount } = require('../../src/utils/payout-account');
const { mapWallet } = require('../../src/utils/mappers');

test('holder name must match the eKYC name (diacritics/case/spacing ignored)', () => {
  assert.equal(normalizeHolderName('  Nguyễn  Văn Đức '), 'NGUYEN VAN DUC');
  const kyc = { subjectType: 'individual', fullName: 'Nguyễn Văn Đức' };
  assert.equal(holderMatchesKyc('NGUYEN VAN DUC', kyc), true);
  assert.equal(holderMatchesKyc('nguyễn văn đức', kyc), true);
  assert.equal(holderMatchesKyc('TRAN VAN B', kyc), false);
  assert.equal(holderMatchesKyc('', kyc), false);
  const org = { subjectType: 'organization', fullName: 'Lê Thị C', orgName: 'Công ty TNHH ABC' };
  assert.equal(holderMatchesKyc('CONG TY TNHH ABC', org), true);
  assert.equal(holderMatchesKyc('LE THI C', org), true);
  assert.equal(holderMatchesKyc('CONG TY TNHH ABC', { fullName: 'Lê Thị C', orgName: 'Công ty TNHH ABC' }), false);
});

test('saved payout account mapping', () => {
  assert.equal(mapPayoutAccount({}), null);
  assert.equal(hasPayoutAccount({ bankName: 'VCB', accountNumber: '0123456789' }), false);
  const m = mapPayoutAccount({ bankName: 'VCB', accountNumber: '0123456789', accountName: 'A B', updatedAt: new Date('2026-10-13T00:00:00Z') });
  assert.equal(m.accountNumberMasked, '••••••6789');
  assert.equal(m.updatedAt, '2026-10-13T00:00:00.000Z');
});

test('withdraw tx shows the full account to admins only', () => {
  const tx = {
    _id: 't1',
    type: 'withdraw',
    amount: 10,
    meta: { payoutAccount: { bankName: 'VCB', accountNumber: '0123456789', accountName: 'A B', source: 'saved' } },
  };
  assert.equal(mapWallet(tx, { admin: true }).payoutAccount.accountNumber, '0123456789');
  const own = mapWallet(tx).payoutAccount;
  assert.equal(own.accountNumber, '');
  assert.equal(own.accountNumberMasked, '••••6789');
  assert.equal(mapWallet({ _id: 't2', type: 'deposit', amount: 1 }).payoutAccount, undefined);
});

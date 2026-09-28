const test = require('node:test');
const assert = require('node:assert/strict');
const { KYC_SIDES, canSubmit, mapKyc, parseKycSubmission } = require('../src/utils/kyc');

const person = { fullName: 'Nguyễn Văn A', idType: 'cccd', idNumber: '079123456789' };

test('selfie is no longer required: front + back is enough to submit', () => {
  assert.deepEqual(KYC_SIDES, ['front', 'back']);
  assert.equal(canSubmit({ frontObjectName: 'a', backObjectName: 'b' }, 'draft'), true);
  assert.equal(canSubmit({ frontObjectName: 'a' }, 'draft'), false);
  assert.equal(canSubmit({ frontObjectName: 'a', backObjectName: 'b' }, 'pending'), false);
});

test('individual requires a personal tax code (10 digits or 12-digit ID number)', () => {
  assert.equal(parseKycSubmission({ ...person }).code, 'INVALID_PERSONAL_TAX_CODE');
  assert.equal(parseKycSubmission({ ...person, personalTaxCode: '12345' }).code, 'INVALID_PERSONAL_TAX_CODE');

  const ok10 = parseKycSubmission({ ...person, personalTaxCode: '8012 345.678' });
  assert.equal(ok10.ok, true);
  assert.equal(ok10.data.personalTaxCode, '8012345678');
  assert.equal(ok10.data.subjectType, 'individual');
  assert.equal(ok10.data.orgName, '');

  assert.equal(parseKycSubmission({ ...person, personalTaxCode: '079123456789' }).ok, true);
});

test('organization requires type, business name, tax code and address', () => {
  const org = {
    ...person,
    subjectType: 'organization',
    orgType: 'company',
    orgName: 'Công ty TNHH ABC',
    orgTaxCode: '0312345678',
    orgAddress: '12 Nguyễn Huệ, Quận 1, TP.HCM',
  };
  const ok = parseKycSubmission(org);
  assert.equal(ok.ok, true);
  assert.equal(ok.data.orgTaxCode, '0312345678');
  assert.equal(ok.data.personalTaxCode, '');

  assert.equal(parseKycSubmission({ ...org, orgType: '' }).code, 'INVALID_ORG_TYPE');
  assert.equal(parseKycSubmission({ ...org, orgName: '' }).code, 'ORG_NAME_REQUIRED');
  assert.equal(parseKycSubmission({ ...org, orgAddress: 'Q1' }).code, 'ORG_ADDRESS_REQUIRED');
  assert.equal(parseKycSubmission({ ...org, orgTaxCode: '0312345678-001' }).ok, true);
  // 12-digit owner ID number is only valid for household businesses.
  assert.equal(parseKycSubmission({ ...org, orgTaxCode: '079123456789' }).code, 'INVALID_ORG_TAX_CODE');
  assert.equal(parseKycSubmission({ ...org, orgType: 'household', orgTaxCode: '079123456789' }).ok, true);
});

test('mapKyc hides org fields for individuals and masks the personal tax code publicly', () => {
  const user = {
    role: 'seller',
    kyc: { status: 'pending', subjectType: 'individual', personalTaxCode: '8012345678', orgName: 'stale', frontObjectName: 'f', backObjectName: 'b' },
  };
  const pub = mapKyc(user);
  assert.equal(pub.orgName, '');
  assert.equal(pub.personalTaxCodeMasked, '••••••5678');
  assert.equal(pub.personalTaxCode, undefined);
  assert.equal(mapKyc(user, { includeSensitive: true }).personalTaxCode, '8012345678');
  assert.equal(mapKyc({ kyc: {} }).subjectType, 'individual');
});

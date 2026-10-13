const test = require('node:test');
const assert = require('node:assert/strict');
const { mapKyc, kycDocumentsOf, ensureKycRecordId, newKycRecordId } = require('../src/utils/kyc');

const user = {
  _id: '6a69f0ccd7faa829b87a8528',
  kyc: {
    status: 'pending',
    subjectType: 'organization',
    recordId: 'kyc_abc',
    frontObjectName: 'aimarkets/kyc/6a69f0ccd7faa829b87a8528/front-1-a.jpg',
    frontFileName: 'cccd-truoc.jpg',
    frontFileSize: 2048,
    frontContentType: 'image/jpeg',
    backObjectName: 'aimarkets/kyc/6a69f0ccd7faa829b87a8528/back-1-b.png',
    licenseObjectName: 'aimarkets/kyc/6a69f0ccd7faa829b87a8528/license-1-c.pdf',
  },
};

test('object keys and record id are only exposed with includeObjectKeys (admin)', () => {
  const owner = mapKyc(user, { includeSensitive: true });
  for (const f of ['frontObjectName', 'backObjectName', 'licenseObjectName', 'documents', 'recordId']) {
    assert.equal(f in owner, false, f);
  }
  assert.equal('documents' in mapKyc(user), false);
  const admin = mapKyc(user, { includeSensitive: true, includeObjectKeys: true });
  assert.equal(admin.userId, '6a69f0ccd7faa829b87a8528');
  assert.equal(admin.recordId, 'kyc_abc');
  assert.equal(admin.documents.length, 3);
});

test('kycDocumentsOf returns key, file name and size with fallbacks', () => {
  const [front, back, license] = kycDocumentsOf(user.kyc);
  assert.deepEqual(front, {
    side: 'front',
    objectKey: user.kyc.frontObjectName,
    fileName: 'cccd-truoc.jpg',
    size: 2048,
    contentType: 'image/jpeg',
  });
  assert.equal(back.fileName, 'back-1-b.png');
  assert.equal(back.size, 0);
  assert.equal(license.contentType, 'application/pdf');
});

test('record id is stable once set', () => {
  assert.match(newKycRecordId(), /^kyc_[a-f0-9]{24}$/);
  const k = {};
  const id = ensureKycRecordId(k);
  assert.equal(ensureKycRecordId(k), id);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PDF_MAX_BYTES,
  isPdfBuffer,
  sniffImageMime,
  isAllowedUploadMime,
  validateKycDocument,
} = require('../src/utils/kyc-upload');
const { mapKyc, licenseFileOf } = require('../src/utils/kyc');

const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100)]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
const file = (buffer, mimetype, size) => ({ buffer, mimetype, size: size ?? buffer.length, originalname: 'x' });

test('magic bytes', () => {
  assert.equal(isPdfBuffer(pdf), true);
  assert.equal(isPdfBuffer(jpg), false);
  assert.equal(sniffImageMime(jpg), 'image/jpeg');
  assert.equal(sniffImageMime(png), 'image/png');
  assert.equal(sniffImageMime(pdf), '');
  assert.equal(isAllowedUploadMime('application/pdf'), true);
  assert.equal(isAllowedUploadMime('text/html'), false);
});

test('business licence must be a real PDF up to 10MB', () => {
  assert.deepEqual(validateKycDocument('license', file(pdf, 'application/pdf')), { ok: true, contentType: 'application/pdf' });
  assert.equal(validateKycDocument('license', file(jpg, 'image/jpeg')).code, 'LICENSE_MUST_BE_PDF');
  // declared as PDF but not one
  assert.equal(validateKycDocument('license', file(jpg, 'application/pdf')).code, 'LICENSE_MUST_BE_PDF');
  const big = validateKycDocument('license', file(pdf, 'application/pdf', PDF_MAX_BYTES + 1));
  assert.equal(big.code, 'FILE_TOO_LARGE');
  assert.equal(big.status, 413);
});

test('ID front/back stay images only', () => {
  assert.equal(validateKycDocument('front', file(jpg, 'image/jpeg')).ok, true);
  assert.equal(validateKycDocument('back', file(png, 'image/png')).contentType, 'image/png');
  assert.equal(validateKycDocument('front', file(pdf, 'application/pdf')).code, 'INVALID_IMAGE');
  assert.equal(validateKycDocument('back', file(pdf, 'image/jpeg')).code, 'INVALID_IMAGE');
  assert.equal(validateKycDocument('front', file(jpg, 'image/jpeg', 8 * 1024 * 1024 + 1)).code, 'FILE_TOO_LARGE');
  assert.equal(validateKycDocument('front', null).code, 'NO_FILE');
});

test('mapKyc exposes licence file metadata (PDF, legacy image fallback)', () => {
  const user = {
    kyc: {
      subjectType: 'organization',
      licenseObjectName: 'aimarkets/kyc/u1/license-1-a.pdf',
      licenseFileName: 'dkkd.pdf',
      licenseFileSize: 12345,
      licenseContentType: 'application/pdf',
    },
  };
  assert.deepEqual(mapKyc(user).licenseFile, { name: 'dkkd.pdf', size: 12345, contentType: 'application/pdf', isPdf: true });
  const legacy = licenseFileOf({ licenseObjectName: 'aimarkets/kyc/u1/license-1-a.jpg' });
  assert.equal(legacy.isPdf, false);
  assert.equal(legacy.name, 'license-1-a.jpg');
  assert.equal(mapKyc({ kyc: { subjectType: 'individual' } }).licenseFile, null);
});

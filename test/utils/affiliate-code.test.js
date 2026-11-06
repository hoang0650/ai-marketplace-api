const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateAffiliateCode,
  isAffiliateCode,
  ensureAffiliateCode,
  backfillAffiliateCodes,
} = require('../../src/utils/affiliate-code');

test('affiliate code has exactly two uppercase letters and four digits', () => {
  for (let i = 0; i < 100; i += 1) {
    assert.match(generateAffiliateCode(), /^[A-Z]{2}\d{4}$/);
  }
});

test('backfill replaces legacy values without changing valid codes', async () => {
  const rows = [
    { _id: '1', affiliateCode: 'PHAI-NGUYEN' },
    { _id: '2', affiliateCode: 'AB1234' },
  ];
  let operations = [];
  const User = {
    find() {
      return { select: () => ({ lean: async () => rows }) };
    },
    async bulkWrite(next) {
      operations = next;
    },
  };

  const result = await backfillAffiliateCodes(User);
  assert.deepEqual(result, { scanned: 2, updated: 1 });
  assert.equal(operations[0].updateOne.filter._id, '1');
  assert.match(operations[0].updateOne.update.$set.affiliateCode, /^[A-Z]{2}\d{4}$/);
});

test('affiliate code validation rejects legacy and malformed values', () => {
  assert.equal(isAffiliateCode('AB1234'), true);
  assert.equal(isAffiliateCode('ab1234'), true);
  assert.equal(isAffiliateCode('PHAI-NGUYEN'), false);
  assert.equal(isAffiliateCode('ABC123'), false);
});

test('allocator retries a database uniqueness collision', async () => {
  let saves = 0;
  const user = {
    affiliateCode: 'PHAI-LEGACY',
    async save() {
      saves += 1;
      if (saves === 1) {
        const err = new Error('duplicate');
        err.code = 11000;
        throw err;
      }
    },
  };

  await ensureAffiliateCode(user);
  assert.equal(saves, 2);
  assert.match(user.affiliateCode, /^[A-Z]{2}\d{4}$/);
});

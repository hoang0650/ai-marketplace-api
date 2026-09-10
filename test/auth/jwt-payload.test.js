const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  userIdFromPayload,
  buildAccessTokenPayload,
} = require('../../src/middleware/auth');
const { generateCacheKey } = require('../../src/utils/cache');

test('userIdFromPayload prefers userId then sub (legacy tokens)', () => {
  assert.equal(userIdFromPayload({ userId: 'abc', sub: 'old' }), 'abc');
  assert.equal(userIdFromPayload({ sub: 'legacy' }), 'legacy');
  assert.equal(userIdFromPayload({}), '');
});

test('buildAccessTokenPayload mirrors phhotel claims plus sub for compatibility', () => {
  const payload = buildAccessTokenPayload({
    _id: '507f1f77bcf86cd799439011',
    email: 'buyer@example.com',
    role: 'buyer',
    accountStatus: 'active',
  });
  assert.equal(payload.userId, '507f1f77bcf86cd799439011');
  assert.equal(payload.sub, '507f1f77bcf86cd799439011');
  assert.equal(payload.email, 'buyer@example.com');
  assert.equal(payload.role, 'buyer');
  assert.equal(payload.status, 'active');
});

test('generateCacheKey matches phhotel auth:user / auth:session shape', () => {
  assert.equal(generateCacheKey('auth', 'user', 'abc'), 'auth:user:abc');
  assert.equal(generateCacheKey('auth', 'session', 'abc'), 'auth:session:abc');
});

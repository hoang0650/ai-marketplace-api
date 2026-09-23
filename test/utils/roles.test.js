const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ROLE,
  USER_ROLES,
  SIGNUP_ROLES,
  normalizeRole,
  hasAnyRole,
  hasCapability,
  withAdmin,
  isSignupRole,
  isEarnerRole,
} = require('../../src/utils/roles');

test('role enum covers the six marketplace roles', () => {
  assert.deepEqual(USER_ROLES, ['buyer', 'seller', 'talent', 'freelancer', 'employer', 'admin']);
});

test('admin is the only role users cannot self-assign', () => {
  assert.ok(!SIGNUP_ROLES.includes(ROLE.ADMIN));
  assert.equal(isSignupRole('admin'), false);
  assert.equal(isSignupRole('employer'), true);
  assert.equal(isSignupRole('creator'), true, 'legacy creator maps to seller');
});

test('legacy creator normalizes to seller', () => {
  assert.equal(normalizeRole('creator'), ROLE.SELLER);
  assert.equal(normalizeRole('Creator'), ROLE.SELLER);
  assert.equal(normalizeRole('seller'), ROLE.SELLER);
  assert.equal(normalizeRole(''), '');
});

test('strict split: only sellers can sell', () => {
  assert.equal(hasCapability({ role: 'seller' }, 'sell'), true);
  assert.equal(hasCapability({ role: 'buyer' }, 'sell'), false);
  assert.equal(hasCapability({ role: 'talent' }, 'sell'), false);
});

test('strict split: only freelancers can take jobs', () => {
  assert.equal(hasCapability({ role: 'freelancer' }, 'freelance'), true);
  assert.equal(hasCapability({ role: 'talent' }, 'freelance'), false);
  assert.equal(hasCapability({ role: 'seller' }, 'freelance'), false);
});

test('strict split: only employers can post jobs', () => {
  assert.equal(hasCapability({ role: 'employer' }, 'hire'), true);
  assert.equal(hasCapability({ role: 'seller' }, 'hire'), false);
});

test('strict split: only talent can own a talent profile', () => {
  assert.equal(hasCapability({ role: 'talent' }, 'talentProfile'), true);
  assert.equal(hasCapability({ role: 'freelancer' }, 'talentProfile'), false);
});

test('admin passes every capability gate', () => {
  for (const capability of ['sell', 'talentProfile', 'freelance', 'hire', 'sellerProfile']) {
    assert.equal(hasCapability({ role: 'admin' }, capability), true, capability);
  }
});

test('seller-like roles see their own orders', () => {
  assert.equal(hasAnyRole({ role: 'seller' }, [ROLE.SELLER]), true);
  assert.equal(hasAnyRole({ role: 'talent' }, [ROLE.SELLER, ROLE.TALENT]), true);
  assert.equal(hasAnyRole({ role: 'buyer' }, [ROLE.SELLER, ROLE.TALENT]), false);
});

test('earner roles are the ones that can withdraw', () => {
  assert.equal(isEarnerRole({ role: 'seller' }), true);
  assert.equal(isEarnerRole({ role: 'freelancer' }), true);
  assert.equal(isEarnerRole({ role: 'employer' }), false);
  assert.equal(isEarnerRole({ role: 'buyer' }), false);
});

test('withAdmin appends the admin role', () => {
  assert.deepEqual(withAdmin(['seller']), ['seller', 'admin']);
});

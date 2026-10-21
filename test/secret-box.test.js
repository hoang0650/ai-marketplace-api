const test = require('node:test');
const assert = require('node:assert');

const KEY = 'test-byok-key-0123456789abcdef0123456789';
process.env.BYOK_ENCRYPTION_KEY = KEY;

const { sealSecret, openSecret } = require('../src/utils/secret-box');
const { revealPassword, sealStoredPassword } = require('../src/services/hermesAccounts');

test('seals with the dedicated key and refuses a missing key', () => {
  const sealed = sealSecret('sk-test-123');
  assert.match(sealed, /^v1\./);
  assert.strictEqual(openSecret(sealed), 'sk-test-123');

  const prev = process.env.BYOK_ENCRYPTION_KEY;
  delete process.env.BYOK_ENCRYPTION_KEY;
  try {
    assert.throws(() => sealSecret('x'), /BYOK_ENCRYPTION_KEY/);
    assert.throws(() => openSecret(sealed), /BYOK_ENCRYPTION_KEY/);
  } finally {
    process.env.BYOK_ENCRYPTION_KEY = prev;
  }
});

test('hermes dashboard passwords are sealed, legacy plaintext still reads', () => {
  const sealed = sealStoredPassword('buyer-password');
  assert.match(sealed, /^v1\./);
  assert.notStrictEqual(sealed, 'buyer-password');
  assert.strictEqual(revealPassword(sealed), 'buyer-password');
  assert.strictEqual(revealPassword('legacy-plain'), 'legacy-plain');
});

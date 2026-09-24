const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { generateSshKeyPair, rsaJwkToOpenssh, sshFingerprint } = require('../src/utils/ssh-keys');

test('generates an OpenSSH public key line with the given comment', () => {
  const pair = generateSshKeyPair({ comment: 'aimarkets-abc123' });
  assert.match(pair.publicKey, /^ssh-rsa AAAA[A-Za-z0-9+/=]+ aimarkets-abc123$/);
  const pem = pair.privateKey.trim();
  assert.ok(pem.startsWith('-----BEGIN RSA PRIVATE KEY-----'));
  assert.ok(pem.endsWith('-----END RSA PRIVATE KEY-----'));
});

test('private key parses back into the same public key (valid pair)', () => {
  const pair = generateSshKeyPair();
  const jwk = crypto.createPublicKey(crypto.createPrivateKey(pair.privateKey)).export({ format: 'jwk' });
  const reencoded = rsaJwkToOpenssh(jwk, pair.comment);
  assert.equal(reencoded, pair.publicKey);
});

test('fingerprint is the base64 SHA-256 of the key blob', () => {
  const pair = generateSshKeyPair();
  const blob = Buffer.from(pair.publicKey.split(/\s+/)[1], 'base64');
  const expected = `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
  assert.equal(pair.fingerprint, expected);
  assert.equal(sshFingerprint(pair.publicKey), expected);
});

test('uses a 3072-bit modulus by default', () => {
  const pair = generateSshKeyPair();
  const key = crypto.createPrivateKey(pair.privateKey);
  assert.equal(crypto.createPublicKey(key).asymmetricKeyDetails.modulusLength, 3072);
});

test('fingerprint of a malformed key is empty', () => {
  assert.equal(sshFingerprint('not-a-key'), '');
  assert.equal(sshFingerprint(''), '');
});

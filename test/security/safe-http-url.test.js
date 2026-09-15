const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseHttpUrl,
  isBlockedHostname,
  isBlockedIp,
  assertSafeStreamHost,
} = require('../../src/utils/safe-http-url');

test('blocks metadata and loopback hosts', () => {
  assert.equal(isBlockedHostname('169.254.169.254'), true);
  assert.equal(isBlockedHostname('127.0.0.1'), true);
  assert.equal(isBlockedHostname('localhost'), true);
  assert.equal(isBlockedHostname('metadata.google.internal'), true);
  assert.equal(isBlockedIp('10.0.0.1'), true);
  assert.equal(isBlockedIp('::1'), true);
});

test('parseHttpUrl rejects non-http and credentialed URLs', () => {
  assert.throws(() => parseHttpUrl('file:///etc/passwd'), /http/);
  assert.throws(() => parseHttpUrl('javascript:alert(1)'), /http/);
  assert.throws(() => parseHttpUrl('http://user:pass@example.com/a'), /credentials/);
  assert.throws(() => parseHttpUrl('http://169.254.169.254/latest/meta-data/'), /host/);
  const ok = parseHttpUrl('https://cdn.example.com/voice.mp3');
  assert.equal(ok.hostname, 'cdn.example.com');
});

test('assertSafeStreamHost allows LAN but not metadata', () => {
  assert.equal(assertSafeStreamHost('10.0.0.5'), '10.0.0.5');
  assert.throws(() => assertSafeStreamHost('169.254.169.254'), /not allowed/);
  assert.throws(() => assertSafeStreamHost('localhost'), /not allowed/);
});

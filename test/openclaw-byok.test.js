const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BYOK_ENCRYPTION_KEY = 'test-byok-key-0123456789abcdef0123456789';
process.env.OPENCLAW_MARKET_TICKET_SECRET = 'test-ticket-secret-0123456789';

const { sealSecret, openSecret } = require('../src/utils/secret-box');
const { issueMarketTicket, verifyMarketTicket } = require('../src/utils/openclaw-ticket');
const { normalizeCustomBaseUrl, getByokProvider } = require('../src/utils/byok-providers');

const UID = '6a69f224e6032a3f00de977f';

test('secret box round-trips and uses a fresh IV', () => {
  const a = sealSecret('sk-test-123');
  const b = sealSecret('sk-test-123');
  assert.notEqual(a, b);
  assert.equal(openSecret(a), 'sk-test-123');
});

test('secret box rejects tampered ciphertext', () => {
  const sealed = sealSecret('sk-test-123').split('.');
  sealed[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => openSecret(sealed.join('.')));
});

test('market ticket verifies for the issued user only', () => {
  const ticket = issueMarketTicket(UID);
  assert.equal(verifyMarketTicket(ticket), UID);
  const [payload, sig] = ticket.split('.');
  const forged = Buffer.from(JSON.stringify({ uid: 'aaaaaaaaaaaaaaaaaaaaaaaa', exp: Date.now() + 60_000 })).toString(
    'base64url'
  );
  assert.equal(verifyMarketTicket(`${forged}.${sig}`), null);
  assert.equal(verifyMarketTicket(`${payload}.x${sig.slice(1)}`), null);
});

test('market ticket expires', () => {
  assert.equal(verifyMarketTicket(issueMarketTicket(UID, -1)), null);
});

test('custom base URL blocks non-https and internal hosts', async () => {
  await assert.rejects(normalizeCustomBaseUrl('http://api.example.com/v1'));
  await assert.rejects(normalizeCustomBaseUrl('https://localhost/v1'));
  await assert.rejects(normalizeCustomBaseUrl('https://127.0.0.1/v1'));
  await assert.rejects(normalizeCustomBaseUrl('https://10.0.1.5/v1'));
  await assert.rejects(normalizeCustomBaseUrl('https://[::1]/v1'));
  await assert.rejects(normalizeCustomBaseUrl('https://user:pass@api.example.com/v1'));
});

test('provider catalog lookups', () => {
  assert.equal(getByokProvider('OpenAI')?.id, 'openai');
  assert.equal(getByokProvider('byok-custom')?.custom, true);
  assert.equal(getByokProvider('featherless'), null);
});

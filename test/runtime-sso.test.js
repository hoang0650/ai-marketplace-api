const test = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENWEBUI_SSO_SECRET = 'test-openwebui-sso-secret-0123456789';
process.env.AIMARKETS_RUNTIME_SSO_SECRET = 'test-shared-runtime-sso-secret-0123';
delete process.env.PAPERCLIP_SSO_SECRET;

const crypto = require('crypto');
const { issueRuntimeTicket, verifyRuntimeTicket } = require('../src/utils/runtime-sso-ticket');
const { buildSsoLaunchUrl, applyTemplate } = require('../src/routes/runtime-sso');

const UID = '6a69f224e6032a3f00de977f';
const user = { _id: UID, name: 'Hoàng <script>', email: 'Buyer@Example.com' };

test('ticket verifies only for its runtime and secret', () => {
  const ticket = issueRuntimeTicket({ runtime: 'openwebui', envPrefix: 'OPENWEBUI', user });
  const data = verifyRuntimeTicket({ runtime: 'openwebui', envPrefix: 'OPENWEBUI', ticket });
  assert.equal(data.uid, UID);
  assert.equal(data.rt, 'openwebui');
  assert.equal(data.email, 'buyer@example.com');
  assert.equal(data.name, 'Hoàng script');
  assert.ok(data.jti);
  // Same bytes are useless on another runtime (domain-separated HMAC + secret).
  assert.equal(verifyRuntimeTicket({ runtime: 'paperclip', envPrefix: 'PAPERCLIP', ticket }), null);
});

test('paperclip falls back to AIMARKETS_RUNTIME_SSO_SECRET', () => {
  const ticket = issueRuntimeTicket({ runtime: 'paperclip', envPrefix: 'PAPERCLIP', user });
  assert.ok(ticket);
  assert.equal(verifyRuntimeTicket({ runtime: 'paperclip', envPrefix: 'PAPERCLIP', ticket }).uid, UID);
});

test('expired and tampered tickets are rejected', () => {
  const now = Date.now();
  const expired = issueRuntimeTicket({ runtime: 'openwebui', envPrefix: 'OPENWEBUI', user, ttlMs: 1000, now: now - 5000 });
  assert.equal(verifyRuntimeTicket({ runtime: 'openwebui', envPrefix: 'OPENWEBUI', ticket: expired }), null);

  const ticket = issueRuntimeTicket({ runtime: 'openwebui', envPrefix: 'OPENWEBUI', user });
  const [, sig] = ticket.split('.');
  const forged = Buffer.from(
    JSON.stringify({ v: 1, rt: 'openwebui', uid: 'aaaaaaaaaaaaaaaaaaaaaaaa', exp: now + 60_000, jti: 'x' })
  ).toString('base64url');
  assert.equal(verifyRuntimeTicket({ runtime: 'openwebui', envPrefix: 'OPENWEBUI', ticket: `${forged}.${sig}` }), null);
});

test('signature matches the documented runtime-side formula', () => {
  const ticket = issueRuntimeTicket({ runtime: 'openwebui', envPrefix: 'OPENWEBUI', user });
  const [payload, sig] = ticket.split('.');
  const expected = crypto
    .createHmac('sha256', process.env.OPENWEBUI_SSO_SECRET)
    .update(`aimr.v1.openwebui.${payload}`)
    .digest('base64url');
  assert.equal(sig, expected);
});

test('no ticket without a valid user id', () => {
  assert.equal(issueRuntimeTicket({ runtime: 'openwebui', envPrefix: 'OPENWEBUI', user: { _id: 'nope' } }), '');
});

test('launch url is https on the buyer host with the ticket in the query', () => {
  const base = applyTemplate('http://{userId}.openwebui.aimarkets.vn/', UID.toUpperCase());
  assert.equal(base, `https://${UID}.openwebui.aimarkets.vn`);
  const url = new URL(buildSsoLaunchUrl({ base, ssoPath: 'api/v1/aimarkets/sso', ticket: 'a.b' }));
  assert.equal(url.origin, `https://${UID}.openwebui.aimarkets.vn`);
  assert.equal(url.pathname, '/api/v1/aimarkets/sso');
  assert.equal(url.searchParams.get('ticket'), 'a.b');
  assert.equal(buildSsoLaunchUrl({ base, ssoPath: '/x', ticket: '' }), null);
  assert.equal(applyTemplate('https://{userId}.x', 'bad'), '');
});

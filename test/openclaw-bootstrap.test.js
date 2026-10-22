const test = require('node:test');
const assert = require('node:assert/strict');
const { requestBootstrapToken, buildBootstrapUrl, signRequest } = require('../src/services/openclaw-bootstrap');
const issuerAuth = require('../infra/ssh-gateway/src/issuer-auth');

const UID = '6a69f0cdd7faa829b87a852e';
const SECRET = 's'.repeat(48);
const env = { OPENCLAW_BOOTSTRAP_ISSUER_URL: 'https://openclaw.aimarkets.vn/__aim/issuer/v1/openclaw/bootstrap-token', SSH_GATEWAY_SHARED_SECRET: SECRET };
const TOKEN = 'A'.repeat(43);

test('API signature verifies with the issuer implementation (shared contract)', () => {
  const body = JSON.stringify({ userId: UID });
  const h = signRequest(SECRET, body);
  assert.equal(issuerAuth.verify(SECRET, { ts: h['X-Aim-Ts'], nonce: h['X-Aim-Nonce'], sig: h['X-Aim-Sig'], body }), null);
  assert.equal(issuerAuth.verify('t'.repeat(48), { ts: h['X-Aim-Ts'], nonce: h['X-Aim-Nonce'], sig: h['X-Aim-Sig'], body }), 'bad_sig');
});

test('requestBootstrapToken returns the token and refuses admin-scoped or malformed answers', async () => {
  const reply = (status, json) => async (url, init) => {
    assert.equal(url, env.OPENCLAW_BOOTSTRAP_ISSUER_URL);
    assert.equal(JSON.parse(init.body).userId, UID);
    assert.ok(init.headers['X-Aim-Sig']);
    return { ok: status === 200, status, json: async () => json };
  };
  const ok = await requestBootstrapToken({ userId: UID, env, fetchImpl: reply(200, { ok: true, token: TOKEN, expiresAtMs: 1, role: 'operator', scopes: ['operator.read'] }) });
  assert.equal(ok.token, TOKEN);
  await assert.rejects(
    requestBootstrapToken({ userId: UID, env, fetchImpl: reply(200, { ok: true, token: TOKEN, role: 'operator', scopes: ['operator.admin'] }) }),
    (e) => e.code === 'issuer_bad_response',
  );
  await assert.rejects(requestBootstrapToken({ userId: UID, env, fetchImpl: reply(429, { ok: false }) }), (e) => e.code === 'rate_limited');
  await assert.rejects(requestBootstrapToken({ userId: UID, env: {}, fetchImpl: reply(200, {}) }), (e) => e.code === 'not_configured');
  await assert.rejects(requestBootstrapToken({ userId: 'nope', env, fetchImpl: reply(200, {}) }), (e) => e.code === 'bad_user');
});

test('bootstrap URL carries the token only in the fragment of the buyer host and no gateway token', () => {
  const url = buildBootstrapUrl({ uiBaseUrl: `https://${UID}.openclaw.aimarkets.vn`, userId: UID, token: TOKEN, extra: { marketTicket: 'mt' } });
  const u = new URL(url);
  assert.equal(u.host, `${UID}.openclaw.aimarkets.vn`);
  assert.equal(u.search, '');
  const h = new URLSearchParams(u.hash.slice(1));
  assert.equal(h.get('bootstrapToken'), TOKEN);
  assert.equal(h.get('gatewayUrl'), `wss://${UID}.openclaw.aimarkets.vn`);
  assert.equal(h.get('marketTicket'), 'mt');
  assert.equal(h.get('token'), null);
  assert.equal(h.get('gatewayToken'), null);
  assert.equal(buildBootstrapUrl({ uiBaseUrl: 'http://x', userId: UID, token: TOKEN }), null);
});

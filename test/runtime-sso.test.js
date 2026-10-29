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

test('NanoClaw buyer tickets carry an owner and never expose the shared dashboard secret', () => {
  process.env.NANOCLAW_DASHBOARD_SECRET = 'fake-shared-admin-token';
  const a = issueRuntimeTicket({ runtime: 'nanoclaw', envPrefix: 'NANOCLAW', user });
  const b = issueRuntimeTicket({ runtime: 'nanoclaw', envPrefix: 'NANOCLAW', user: { ...user, _id: 'b'.repeat(24) } });
  assert.notEqual(a, process.env.NANOCLAW_DASHBOARD_SECRET);
  assert.notEqual(a, b);
  assert.equal(verifyRuntimeTicket({ runtime: 'nanoclaw', envPrefix: 'NANOCLAW', ticket: a }).uid, UID);
  assert.equal(verifyRuntimeTicket({ runtime: 'nanoclaw', envPrefix: 'NANOCLAW', ticket: b }).uid, 'b'.repeat(24));
  assert.equal(verifyRuntimeTicket({ runtime: 'openwebui', envPrefix: 'OPENWEBUI', ticket: a }), null);
  delete process.env.NANOCLAW_DASHBOARD_SECRET;
});

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

const { createByokClaimHandler, toOpenAICompatibleConnection } = require('../src/routes/runtime-byok-claim');

function callClaim(handler, { secret, ticket }) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      set() {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
      },
    };
    handler({ headers: { 'x-runtime-secret': secret }, body: { ticket } }, res, reject);
  });
}

test('byok claim returns only the ticket owner keys, once, for the runtime secret holder', async () => {
  const seen = [];
  const handler = createByokClaimHandler({
    runtime: 'openwebui',
    envPrefix: 'OPENWEBUI',
    loadKeys: async (uid) => {
      seen.push(uid);
      return [
        { provider: 'openai', apiKey: 'sk-a' },
        { provider: 'byok-custom', apiKey: 'sk-c', baseUrl: 'https://llm.example.com/v1/', model: 'llama-3.3' },
        { provider: 'unknown', apiKey: 'x' },
      ];
    },
  });
  const secret = process.env.OPENWEBUI_SSO_SECRET;
  const ticket = issueRuntimeTicket({ runtime: 'openwebui', envPrefix: 'OPENWEBUI', user });

  assert.equal((await callClaim(handler, { secret: 'wrong', ticket })).status, 401);
  const paperclipTicket = issueRuntimeTicket({ runtime: 'paperclip', envPrefix: 'PAPERCLIP', user });
  assert.equal((await callClaim(handler, { secret, ticket: paperclipTicket })).status, 401);

  const ok = await callClaim(handler, { secret, ticket });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.userId, UID);
  assert.deepEqual(seen, [UID]);
  assert.deepEqual(ok.body.connections, [
    { provider: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-a', modelIds: [] },
    {
      provider: 'byok-custom',
      label: 'OpenAI-compatible (custom)',
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'sk-c',
      modelIds: ['llama-3.3'],
    },
  ]);

  assert.equal((await callClaim(handler, { secret, ticket })).status, 409);
});

test('every built-in BYOK provider maps to an https OpenAI-compatible endpoint', () => {
  for (const id of ['openai', 'anthropic', 'google', 'openrouter', 'deepseek', 'groq', 'xai']) {
    const conn = toOpenAICompatibleConnection({ provider: id, apiKey: 'k' });
    assert.ok(conn && conn.baseUrl.startsWith('https://'), id);
  }
  assert.equal(toOpenAICompatibleConnection({ provider: 'byok-custom', apiKey: 'k', baseUrl: 'http://x' }), null);
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

// Exercise the production database-backed replay guard without a live database.
test.beforeEach(() => {
  const used = new Set();
  test.mock.method(require('../src/models/RuntimeByokClaim'), 'create', async row => {
    if (used.has(row._id)) { const err = new Error('duplicate'); err.code = 11000; throw err; }
    used.add(row._id); return row;
  });
  test.mock.method(require('../src/models/User'), 'findById', () => ({ select: () => ({ lean: async () => ({ accountStatus: 'active' }) }) }));
});
test.afterEach(() => test.mock.restoreAll());

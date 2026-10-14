const test = require('node:test');
const assert = require('node:assert/strict');
const { cliEnv } = require('../src/gateway');
const { ApiClient } = require('../src/api');

const TOKEN = `amc1.${'a'.repeat(40)}.${'b'.repeat(43)}`;

test('cliEnv injects only the per-session CLI token', () => {
  assert.deepEqual(cliEnv({ agentId: 'openclaw', expiresAt: 'x' }), []);
  const env = cliEnv({ agentId: 'openclaw', expiresAt: 'x', cli: { token: TOKEN, apiUrl: 'https://api.aimarkets.vn' } });
  assert.ok(env.includes(`AIMARKETS_CMD_TOKEN=${TOKEN}`));
  assert.ok(env.includes('AIMARKETS_API_URL=https://api.aimarkets.vn'));
});

test('ApiClient.verify keeps a well-formed CLI token and drops malformed ones', async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const mk = (extra) =>
    new ApiClient({
      apiBaseUrl: 'https://api.test/v1',
      apiSecret: 's',
      fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true, userId: 'u', agentId: 'openclaw', expiresAt, ...extra }) }),
    });
  assert.deepEqual((await mk({ commandToken: TOKEN, apiUrl: 'https://api.aimarkets.vn' }).verify('a', 'b')).cli, {
    token: TOKEN,
    apiUrl: 'https://api.aimarkets.vn',
  });
  assert.equal((await mk({ commandToken: 'x; rm -rf /', apiUrl: 'https://api.aimarkets.vn' }).verify('a', 'b')).cli, undefined);
  assert.equal((await mk({ commandToken: TOKEN, apiUrl: 'http://evil' }).verify('a', 'b')).cli, undefined);
});

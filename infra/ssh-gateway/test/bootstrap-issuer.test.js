const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { createIssuerHandler, SCOPE_ALLOWLIST, MINT_SCRIPT, PATH, mintInGateway } = require('../src/bootstrap-issuer');
const { sign } = require('../src/issuer-auth');

const SECRET = 'x'.repeat(48);
const USER = '6a69f0cdd7faa829b87a852e';
const cfg = { apiSecret: SECRET, issuerWindowMs: 600_000, issuerPerUserMax: 2, issuerGlobalMax: 3 };

async function withServer(handler, fn) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${srv.address().port}`);
  } finally {
    srv.close();
  }
}

function signed(body, { secret = SECRET, ts = Date.now(), nonce = crypto.randomBytes(16).toString('base64url') } = {}) {
  return { 'x-aim-ts': String(ts), 'x-aim-nonce': nonce, 'x-aim-sig': sign(secret, String(ts), nonce, body), 'content-type': 'application/json' };
}

function makeHandler(calls) {
  const logs = [];
  const handler = createIssuerHandler({
    cfg,
    log: (e, f) => logs.push({ e, ...f }),
    mint: async () => {
      calls.n += 1;
      return { token: `tok_${'a'.repeat(40)}_${calls.n}`, expiresAtMs: Date.now() + 600_000 };
    },
  });
  return { handler, logs };
}

test('allowlist never contains admin or pairing scopes; mint script pins operator + control-ui', () => {
  assert.ok(!SCOPE_ALLOWLIST.includes('operator.admin'));
  assert.ok(!SCOPE_ALLOWLIST.includes('operator.pairing'));
  assert.match(MINT_SCRIPT, /roles: \['operator'\]/);
  assert.match(MINT_SCRIPT, /purpose: 'control-ui'/);
  assert.ok(!MINT_SCRIPT.includes('operator.admin'));
});

test('signed request gets a token; tokens are never logged', async () => {
  const calls = { n: 0 };
  const { handler, logs } = makeHandler(calls);
  await withServer(handler, async (base) => {
    const body = JSON.stringify({ userId: USER });
    const res = await fetch(base + PATH, { method: 'POST', headers: signed(body), body });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.deepEqual(j.scopes, SCOPE_ALLOWLIST);
    assert.ok(!JSON.stringify(logs).includes(j.token));
    assert.equal(logs.at(-1).e, 'bootstrap_issued');
  });
});

test('bad signature, wrong secret, stale timestamp and replayed nonce are rejected', async () => {
  const calls = { n: 0 };
  const { handler } = makeHandler(calls);
  await withServer(handler, async (base) => {
    const body = JSON.stringify({ userId: USER });
    const post = (headers, b = body) => fetch(base + PATH, { method: 'POST', headers, body: b });
    assert.equal((await post(signed(body, { secret: 'y'.repeat(48) }))).status, 401);
    assert.equal((await post(signed(body, { ts: Date.now() - 120_000 }))).status, 401);
    const h = signed(body);
    assert.equal((await post(h, JSON.stringify({ userId: '6a69f224e6032a3f00de977f' }))).status, 401); // body swapped
    assert.equal((await post(h)).status, 200);
    assert.equal((await post(h)).status, 401); // replay
    assert.equal((await post({ 'content-type': 'application/json' })).status, 401);
    assert.equal(calls.n, 1);
  });
});

test('bad user id is refused and rate limits apply per user and globally', async () => {
  const calls = { n: 0 };
  const { handler } = makeHandler(calls);
  await withServer(handler, async (base) => {
    const post = (userId) => {
      const body = JSON.stringify({ userId });
      return fetch(base + PATH, { method: 'POST', headers: signed(body), body });
    };
    assert.equal((await post('admin')).status, 400);
    assert.equal((await post(USER)).status, 200);
    assert.equal((await post(USER)).status, 200);
    assert.equal((await post(USER)).status, 429);
    assert.equal((await post('6a69f224e6032a3f00de977f')).status, 200);
    assert.equal((await post('6a69f224e6032a3f00de977e')).status, 429); // global 3
  });
});

test('mintInGateway fails closed on bad output and passes a fixed command', async () => {
  const seen = {};
  const docker = (stdout, exitCode = 0) => ({
    findServiceContainer: async (svc) => (seen.svc = svc, 'cid'),
    execCollect: async (id, cmd, opts) => (Object.assign(seen, { id, cmd, opts }), { stdout, exitCode }),
  });
  const c = { openclawService: 'phhotel-openclaw-cexp1q', openclawUser: 'node', mintTimeoutMs: 1000 };
  const ok = await mintInGateway(docker(`noise\n${JSON.stringify({ ok: true, token: 'T'.repeat(43), expiresAtMs: 1 })}\n`), c);
  assert.equal(ok.token.length, 43);
  assert.deepEqual(seen.cmd.slice(0, 3), ['node', '--input-type=module', '-e']);
  assert.equal(seen.cmd[3], MINT_SCRIPT);
  await assert.rejects(mintInGateway(docker('{"ok":false,"error":"issuer_not_found"}', 2), c), /issuer_not_found/);
  await assert.rejects(mintInGateway(docker('{"ok":true,"token":"bad token!","expiresAtMs":1}'), c), /mint failed/);
});

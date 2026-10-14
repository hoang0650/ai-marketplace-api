const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AGENT_COMMAND_TOKEN_SECRET = 'test-agent-command-secret-0123456789abcdef';

const { issueCommandToken, verifyCommandToken, readCommandToken } = require('../src/utils/agent-command-token');
const { approveOwnPairing, checkPendingOwnership, PairingError } = require('../src/services/openclaw-pairing');

const UID = '6a69f0cdd7faa829b87a852e';
const OTHER = '6a69f224e6032a3f00de977f';
const RID = 'b1a1a3d1-e703-4298-b70b-63f96661bd01';

test('command token is bound to user, runtime and action', () => {
  const t = issueCommandToken({ userId: UID, runtime: 'openclaw', action: 'pairing.approve' });
  assert.match(t, /^amc1\./);
  assert.equal(verifyCommandToken(t, { runtime: 'openclaw', action: 'pairing.approve' }).uid, UID);
  assert.equal(verifyCommandToken(t, { runtime: 'hermes', action: 'pairing.approve' }), null);
  assert.equal(verifyCommandToken(t, { runtime: 'openclaw', action: 'launch' }), null);
});

test('command token expires and rejects tampering', () => {
  const now = Date.now();
  const t = issueCommandToken({ userId: UID, runtime: 'paperclip', action: 'launch', ttlMs: 60_000, now });
  assert.ok(verifyCommandToken(t, { runtime: 'paperclip', action: 'launch', now: now + 30_000 }));
  assert.equal(verifyCommandToken(t, { runtime: 'paperclip', action: 'launch', now: now + 61_000 }), null);
  const [p0, payload, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), uid: OTHER })).toString('base64url');
  assert.equal(verifyCommandToken(`${p0}.${forged}.${sig}`, { runtime: 'paperclip', action: 'launch' }), null);
});

test('ttl is capped and unknown runtimes/actions/users are refused', () => {
  const now = Date.now();
  const t = issueCommandToken({ userId: UID, runtime: 'openclaw', action: 'launch', ttlMs: 24 * 3600e3, now });
  const claims = verifyCommandToken(t, { now });
  assert.ok(claims.exp - now <= 30 * 60 * 1000);
  assert.equal(issueCommandToken({ userId: UID, runtime: 'root', action: 'launch' }), '');
  assert.equal(issueCommandToken({ userId: UID, runtime: 'openclaw', action: 'config.set' }), '');
  assert.equal(issueCommandToken({ userId: 'admin', runtime: 'openclaw', action: 'launch' }), '');
});

test('readCommandToken only accepts the amc1 format', () => {
  const t = issueCommandToken({ userId: UID, runtime: 'openclaw', action: 'launch' });
  assert.equal(readCommandToken({ headers: { authorization: `AgentCommand ${t}` } }), t);
  assert.equal(readCommandToken({ headers: { authorization: 'Bearer eyJhbGciOi.jwt.value' } }), '');
});

const opts = { userId: UID, hostSuffix: 'openclaw.aimarkets.vn', allowedScopes: [] };
const pending = (over = {}) => ({
  requestId: RID,
  deviceId: 'dev-1',
  role: 'operator',
  scopes: ['operator.read', 'operator.write'],
  browserOrigin: `https://${UID}.openclaw.aimarkets.vn`,
  ...over,
});

test('ownership: own origin + operator scopes is allowed', () => {
  assert.equal(checkPendingOwnership(pending(), opts), null);
});

test('ownership: another buyer, the bare host, or a look-alike host is refused', () => {
  for (const origin of [
    `https://${OTHER}.openclaw.aimarkets.vn`,
    'https://openclaw.aimarkets.vn',
    `https://${UID}.openclaw.aimarkets.vn.evil.test`,
    undefined,
  ]) {
    const err = checkPendingOwnership(pending({ browserOrigin: origin }), opts);
    assert.ok(err instanceof PairingError);
    assert.equal(err.code, 'not_owner');
  }
});

test('ownership: admin/pairing scopes and node roles cannot be self-approved', () => {
  assert.equal(checkPendingOwnership(pending({ scopes: ['operator.admin'] }), opts).code, 'scope_not_allowed');
  assert.equal(checkPendingOwnership(pending({ scopes: ['operator.pairing'] }), opts).code, 'scope_not_allowed');
  assert.equal(checkPendingOwnership(pending({ role: 'node' }), opts).code, 'role_not_allowed');
  assert.equal(checkPendingOwnership(undefined, opts).code, 'not_found');
});

function fakeGateway(list) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: body.method, params: body.params });
    const payload = body.method === 'device.pair.list' ? { pending: list, paired: [] } : { approved: true };
    return { ok: true, status: 200, json: async () => ({ id: body.id, ok: true, payload }) };
  };
  return { calls, fetchImpl };
}

const env = { OPENCLAW_GATEWAY_ADMIN_URL: 'https://gw.internal', OPENCLAW_GATEWAY_ADMIN_TOKEN: 'srv-only' };

test("approveOwnPairing approves only the buyer's own request", async () => {
  const foreign = pending({ requestId: 'other-request-123', browserOrigin: `https://${OTHER}.openclaw.aimarkets.vn` });
  const gw = fakeGateway([pending(), foreign]);
  const r = await approveOwnPairing({ userId: UID, requestId: RID, fetchImpl: gw.fetchImpl, env });
  assert.equal(r.approved, true);
  assert.deepEqual(gw.calls.map((c) => c.method), ['device.pair.list', 'device.pair.approve']);
  assert.deepEqual(gw.calls[1].params, { requestId: RID });
  assert.equal(JSON.stringify(r).includes('srv-only'), false);

  const gw2 = fakeGateway([foreign]);
  await assert.rejects(
    approveOwnPairing({ userId: UID, requestId: 'other-request-123', fetchImpl: gw2.fetchImpl, env }),
    (e) => e.code === 'not_owner'
  );
  assert.deepEqual(gw2.calls.map((c) => c.method), ['device.pair.list']);
});

test('approveOwnPairing: clear 503/502 (not a 500 crash) when gateway is missing or down', async () => {
  await assert.rejects(approveOwnPairing({ userId: UID, requestId: RID, env: {} }), (e) => e.status === 503 && e.code === 'not_configured');
  await assert.rejects(approveOwnPairing({ userId: UID, requestId: '../../x', env }), (e) => e.code === 'bad_request_id');
  const down = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(approveOwnPairing({ userId: UID, requestId: RID, env, fetchImpl: down }), (e) => e.status === 502);
});

test('setup commands embed only per-user scoped tokens, never shared secrets', () => {
  process.env.AIMARKETS_SERVICE_SECRET = 'shared-service-secret-should-not-leak';
  process.env.OPENCLAW_GATEWAY_ADMIN_TOKEN = 'gateway-admin-should-not-leak';
  const { buildCommands } = require('../src/routes/agent-connect');
  for (const runtime of ['openclaw', 'hermes', 'nanoclaw', 'spacebot', 'paperclip', 'openwebui']) {
    const cmds = buildCommands({ runtime, userId: UID, ssh: null });
    const text = JSON.stringify(cmds);
    assert.equal(text.includes('shared-service-secret'), false, runtime);
    assert.equal(text.includes('gateway-admin'), false, runtime);
    assert.equal(/root@/.test(text), false, runtime);
    for (const c of cmds) {
      assert.ok(c.scope.startsWith(`${runtime}:${UID}:`), `${runtime} ${c.id}`);
      const tok = (c.command || '').match(/amc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
      if (tok) {
        assert.equal(verifyCommandToken(tok[0], { runtime }).uid, UID);
        assert.ok(c.command.includes(`/v1/agent-connect/${runtime}/`));
      }
    }
  }
  assert.ok(buildCommands({ runtime: 'openclaw', userId: UID, ssh: null }).some((c) => c.id === 'pairing-approve'));
  assert.ok(buildCommands({ runtime: 'paperclip', userId: UID, ssh: null }).some((c) => c.id === 'cli-launch'));
});
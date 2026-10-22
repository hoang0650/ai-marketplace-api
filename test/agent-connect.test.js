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

test('approveOwnPairing without an id approves only the newest request from this buyer', async () => {
  const older = pending({ requestId: 'own-older-request-1' });
  const newer = pending({ requestId: 'own-newer-request-2' });
  const foreign = pending({ requestId: 'other-request-123', browserOrigin: `https://${OTHER}.openclaw.aimarkets.vn` });
  const gw = fakeGateway([older, foreign, newer]);
  const r = await approveOwnPairing({ userId: UID, fetchImpl: gw.fetchImpl, env });
  assert.equal(r.requestId, 'own-newer-request-2');
  assert.deepEqual(gw.calls[1].params, { requestId: 'own-newer-request-2' });

  const gw2 = fakeGateway([foreign]);
  await assert.rejects(approveOwnPairing({ userId: UID, fetchImpl: gw2.fetchImpl, env }), (e) => e.code === 'not_found');
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
test('pairing.manage tokens live as long as an SSH session and are accepted for list + approve only', () => {
  const now = Date.now();
  const t = issueCommandToken({ userId: UID, runtime: 'openclaw', action: 'pairing.manage', ttlMs: 60 * 60 * 1000, now });
  const c = verifyCommandToken(t, { runtime: 'openclaw', action: ['pairing.list', 'pairing.manage'], now: now + 59 * 60 * 1000 });
  assert.equal(c.uid, UID);
  assert.equal(verifyCommandToken(t, { runtime: 'openclaw', action: ['launch'], now }), null);
  assert.equal(verifyCommandToken(t, { runtime: 'hermes', action: ['pairing.manage'], now }), null);
  const capped = issueCommandToken({ userId: UID, runtime: 'openclaw', action: 'pairing.manage', ttlMs: 24 * 3600e3, now });
  assert.ok(verifyCommandToken(capped, { now }).exp - now <= 65 * 60 * 1000);
});

test('terminal commands: single-line cmd.exe, PowerShell and POSIX variants', () => {
  const { buildCommands } = require('../src/routes/agent-connect');
  const approve = buildCommands({ runtime: 'openclaw', userId: UID, ssh: null }).find((c) => c.id === 'pairing-approve');
  const { cmd, powershell, posix } = approve.variants;
  for (const v of [cmd, powershell, posix]) {
    assert.equal(v.includes('\n'), false);
    assert.equal(v.includes(' \\'), false);
    assert.ok(v.includes('REQUEST_ID'));
    assert.ok(v.includes('https://api.aimarkets.vn/v1/agent-connect/openclaw/pairing/approve'));
  }
  assert.equal(cmd.includes("'"), false, 'cmd.exe has no single-quote strings');
  assert.match(cmd, /^curl\.exe /);
  assert.ok(cmd.includes('-d "{\\"requestId\\":\\"REQUEST_ID\\"}"'));
  assert.equal(/[<>|&]/.test(cmd), false, 'no cmd.exe metacharacters');
  assert.match(powershell, /^Invoke-RestMethod /);
  assert.ok(buildCommands({ runtime: 'openclaw', userId: UID, ssh: null }).some((c) => c.id === 'pairing-list'));
});

test('listOwnPairings returns only this buyer\'s requests', async () => {
  const { listOwnPairings } = require('../src/services/openclaw-pairing');
  const foreign = pending({ requestId: 'other-request-123', browserOrigin: `https://${OTHER}.openclaw.aimarkets.vn` });
  const admin = pending({ requestId: 'admin-request-123', scopes: ['operator.admin'] });
  const gw = fakeGateway([pending(), foreign, admin]);
  const list = await listOwnPairings({ userId: UID, fetchImpl: gw.fetchImpl, env });
  assert.deepEqual(list.map((p) => [p.requestId, p.approvable]), [[RID, true], ['admin-request-123', false]]);
  assert.deepEqual(gw.calls.map((c) => c.method), ['device.pair.list']);
});

test('ssh gateway hands the sandbox a pairing.manage token for openclaw only, expiring with the session', () => {
  const { sandboxCliToken } = require('../src/routes/ssh-gateway');
  const now = Date.now();
  const expiresAt = new Date(now + 45 * 60 * 1000).toISOString();
  const r = sandboxCliToken({ userId: UID, agentId: 'openclaw', expiresAt }, now);
  const c = verifyCommandToken(r.commandToken, { runtime: 'openclaw', action: 'pairing.manage', now });
  assert.equal(c.uid, UID);
  assert.ok(Math.abs(c.exp - Date.parse(expiresAt)) < 1000);
  assert.equal(r.commandToken.includes('gateway-admin'), false);
  assert.equal(sandboxCliToken({ userId: UID, agentId: 'hermes', expiresAt }, now), null);
  assert.equal(sandboxCliToken({ userId: UID, agentId: 'openclaw', expiresAt: new Date(now - 1).toISOString() }, now), null);
});

// OpenClaw 2026.10.5+: Control UI pending requests have no browserOrigin, only remoteIp/clientId/createdAtMs.
const v2 = (over = {}) => {
  const p = { ...pending(), clientId: 'openclaw-control-ui', remoteIp: '118.68.108.235', createdAtMs: Date.now(), ...over };
  delete p.browserOrigin;
  return p;
};

test('2026.10.5 format: same public IP + Control UI + fresh is allowed', () => {
  assert.equal(checkPendingOwnership(v2(), { ...opts, clientIp: '118.68.108.235' }), null);
  assert.equal(checkPendingOwnership(v2({ remoteIp: '::ffff:118.68.108.235' }), { ...opts, clientIp: '118.68.108.235' }), null);
});

test('2026.10.5 format: other IP, no IP, non-Control-UI client, or stale request is refused', () => {
  for (const [p, ip] of [
    [v2(), '1.2.3.4'],
    [v2(), undefined],
    [v2({ remoteIp: undefined }), '118.68.108.235'],
    [v2({ clientId: 'openclaw-cli' }), '118.68.108.235'],
    [v2({ createdAtMs: Date.now() - 60 * 60 * 1000 }), '118.68.108.235'],
  ]) {
    assert.equal(checkPendingOwnership(p, { ...opts, clientIp: ip }).code, 'not_owner');
  }
  // A recorded origin still wins over IP matching.
  const foreign = { ...v2(), browserOrigin: `https://${OTHER}.openclaw.aimarkets.vn` };
  assert.equal(checkPendingOwnership(foreign, { ...opts, clientIp: '118.68.108.235' }).code, 'not_owner');
});

test('2026.10.5 format: approve and list work end to end', async () => {
  const { listOwnPairings } = require('../src/services/openclaw-pairing');
  const gw = fakeGateway([v2(), v2({ requestId: 'someone-else-req', remoteIp: '9.9.9.9' })]);
  const listed = await listOwnPairings({ userId: UID, clientIp: '118.68.108.235', fetchImpl: gw.fetchImpl, env });
  assert.deepEqual(listed.map((p) => p.requestId), [RID]);
  assert.equal(listed[0].approvable, true);
  const r = await approveOwnPairing({ userId: UID, requestId: RID, clientIp: '118.68.108.235', fetchImpl: gw.fetchImpl, env });
  assert.equal(r.approved, true);
  await assert.rejects(
    approveOwnPairing({ userId: UID, requestId: 'someone-else-req', clientIp: '118.68.108.235', fetchImpl: gw.fetchImpl, env }),
    (e) => e.code === 'not_owner'
  );
});

test('scopes: Control UI 2026.10.5 default set is refused for buyers with a clear message', () => {
  const p = pending({ scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.questions', 'operator.pairing'] });
  const err = checkPendingOwnership(p, opts);
  assert.equal(err.code, 'scope_not_allowed');
  assert.deepEqual(err.disallowedScopes, ['operator.admin', 'operator.pairing']);
  assert.match(err.message, /^Not allowed: .*gateway admin permissions \(operator\.admin, operator\.pairing\)/);
  assert.equal(checkPendingOwnership(pending({ scopes: ['operator.questions', 'operator.read'] }), opts), null);
});

test('scopes: configured gateway owners may approve the full default set; roles still enforced', () => {
  const full = ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.questions', 'operator.pairing'];
  assert.equal(checkPendingOwnership(pending({ scopes: full }), { ...opts, ownerUserIds: [UID] }), null);
  assert.equal(checkPendingOwnership(pending({ scopes: full }), { ...opts, ownerUserIds: [OTHER] }).code, 'scope_not_allowed');
  assert.equal(checkPendingOwnership(pending({ role: 'node' }), { ...opts, ownerUserIds: [UID] }).code, 'role_not_allowed');
  const foreign = pending({ scopes: full, browserOrigin: `https://${OTHER}.openclaw.aimarkets.vn` });
  assert.equal(checkPendingOwnership(foreign, { ...opts, ownerUserIds: [UID] }).code, 'not_owner');
  const { gatewayConfig } = require('../src/services/openclaw-pairing');
  assert.deepEqual(gatewayConfig({ OPENCLAW_PAIRING_OWNER_USER_IDS: ` ${UID.toUpperCase()}, bad,` }).ownerUserIds, [UID]);
});

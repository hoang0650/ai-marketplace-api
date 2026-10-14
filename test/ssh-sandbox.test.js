const test = require('node:test');
const assert = require('node:assert/strict');
const sandbox = require('../src/services/ssh-sandbox');

const USER = '65f0aa11bb22cc33dd44ee55';

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  const restore = () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  let out;
  try {
    out = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

/** Minimal in-memory stand-in for the SshSession mongoose model. */
function fakeModel() {
  const rows = [];
  let seq = 0;
  const matches = (row, q) =>
    Object.entries(q).every(([k, v]) => {
      const val = k === 'user' ? String(row.user) : row[k];
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('$gt' in v) return val > v.$gt;
        if ('$in' in v) return v.$in.includes(val);
      }
      if (v === null) return val === null || val === undefined;
      return val === v;
    });
  const chain = (result) => ({ select: () => chain(result), sort: () => chain(result), lean: async () => result });
  return {
    rows,
    async updateMany(q, u) {
      rows.filter((r) => matches(r, q)).forEach((r) => Object.assign(r, u.$set));
    },
    async create(doc) {
      const row = { _id: { toString: () => `s${++seq}` }, revokedAt: null, createdAt: new Date(), ...doc };
      row.user = String(doc.user);
      rows.push(row);
      return row;
    },
    findOne(q) {
      const found = rows.filter((r) => matches(r, q)).pop() || null;
      return chain(found ? { ...found } : null);
    },
    find(q) {
      return chain(rows.filter((r) => matches(r, q)).map((r) => ({ ...r })));
    },
  };
}

test('sandbox usernames are bound to agent + 24-hex user id', () => {
  assert.equal(sandbox.sandboxUsername('openclaw', USER.toUpperCase()), `oc-${USER}`);
  assert.deepEqual(sandbox.parseSandboxUsername(`hm-${USER}`), { agentId: 'hermes', userId: USER });
  assert.equal(sandbox.parseSandboxUsername('root'), null);
  assert.equal(sandbox.parseSandboxUsername(`zz-${USER}`), null);
  assert.equal(sandbox.parseSandboxUsername(`oc-${USER}x`), null);
  assert.throws(() => sandbox.sandboxUsername('openclaw', 'anon'));
  assert.throws(() => sandbox.sandboxUsername('paperclip', USER));
});

test('gateway target never resolves to port 22', () => {
  withEnv({ SSH_GATEWAY_PORT: '22', OPENCLAW_SSH_GATEWAY_PORT: undefined, SSH_GATEWAY_HOST: 'gw.example' }, () => {
    assert.deepEqual(sandbox.gatewayTarget('openclaw'), { host: 'gw.example', port: 2422 });
  });
  withEnv({ OPENCLAW_SSH_GATEWAY_PORT: '2422' }, () => {
    assert.equal(sandbox.gatewayTarget('openclaw').port, 2422);
  });
});

test('hashSecret/verifySecret round-trip and reject tampering', () => {
  const h = sandbox.hashSecret('s3cret');
  assert.match(h, /^scrypt\$16384\$/);
  assert.ok(!h.includes('s3cret'));
  assert.equal(sandbox.verifySecret('s3cret', h), true);
  assert.equal(sandbox.verifySecret('S3cret', h), false);
  assert.equal(sandbox.verifySecret('s3cret', ''), false);
  assert.equal(sandbox.verifySecret('s3cret', 'scrypt$1$a$b'), false);
  assert.notEqual(sandbox.hashSecret('s3cret'), h, 'salted');
});

test('issue stores only a hash and revokes previous sessions', () =>
  withEnv({ OPENCLAW_SSH_PER_USER_ISOLATION: '1', SSH_GATEWAY_HOST: 'ssh.test', SSH_GATEWAY_PORT: '2422' }, async () => {
    const M = fakeModel();
    const user = { _id: USER };
    const first = await sandbox.issueIsolatedSshSession({ SshSession: M, user, agentId: 'openclaw' });
    const second = await sandbox.issueIsolatedSshSession({ SshSession: M, user, agentId: 'openclaw' });
    assert.equal(M.rows.length, 2);
    assert.ok(M.rows[0].revokedAt, 'first revoked');
    assert.equal(M.rows[1].password, undefined, 'no plaintext stored');
    assert.ok(M.rows[1].passwordHash && !M.rows[1].passwordHash.includes(second.password));
    assert.equal(second.command, `ssh -p 2422 oc-${USER}@ssh.test`);
    assert.equal(
      await sandbox.verifyGatewayLogin({ SshSession: M, username: second.username, password: first.password }),
      null,
      'old password rejected after reissue'
    );
    const ok = await sandbox.verifyGatewayLogin({ SshSession: M, username: second.username, password: second.password });
    assert.equal(ok.userId, USER);
    assert.equal(ok.agentId, 'openclaw');
  }));

test('gateway login rejects expired, revoked, wrong-user and flag-off sessions', () =>
  withEnv({ OPENCLAW_SSH_PER_USER_ISOLATION: '1' }, async () => {
    const M = fakeModel();
    const user = { _id: USER };
    const t0 = new Date('2026-10-14T00:00:00Z');
    const s = await sandbox.issueIsolatedSshSession({ SshSession: M, user, agentId: 'openclaw', now: t0 });
    const at = (ms) => new Date(t0.getTime() + ms);
    assert.ok(await sandbox.verifyGatewayLogin({ SshSession: M, username: s.username, password: s.password, now: at(1000) }));
    assert.equal(
      await sandbox.verifyGatewayLogin({ SshSession: M, username: s.username, password: s.password, now: at(sandbox.SSH_TTL_MS + 1) }),
      null,
      'expired'
    );
    const other = `oc-${'1'.repeat(24)}`;
    assert.equal(await sandbox.verifyGatewayLogin({ SshSession: M, username: other, password: s.password, now: at(1000) }), null);
    assert.equal(await sandbox.verifyGatewayLogin({ SshSession: M, username: `hm-${USER}`, password: s.password, now: at(1000) }), null);
    await withEnv({ OPENCLAW_SSH_PER_USER_ISOLATION: '0' }, async () => {
      assert.equal(await sandbox.verifyGatewayLogin({ SshSession: M, username: s.username, password: s.password, now: at(1000) }), null);
      assert.deepEqual(await sandbox.listActiveSandboxSessions({ SshSession: M, now: at(1000) }), []);
    });
    assert.equal((await sandbox.listActiveSandboxSessions({ SshSession: M, now: at(1000) })).length, 1);
    await M.updateMany({ user: USER }, { $set: { revokedAt: at(2000) } });
    assert.equal(await sandbox.verifyGatewayLogin({ SshSession: M, username: s.username, password: s.password, now: at(3000) }), null);
    assert.deepEqual(await sandbox.listActiveSandboxSessions({ SshSession: M, now: at(3000) }), []);
  }));

test('gateway secret must be long and match exactly', () => {
  const { gatewaySecretOk } = require('../src/routes/ssh-gateway');
  const secret = 'x'.repeat(40);
  withEnv({ SSH_GATEWAY_SHARED_SECRET: secret }, () => {
    assert.equal(gatewaySecretOk({ headers: { 'x-ssh-gateway-secret': secret } }), true);
    assert.equal(gatewaySecretOk({ headers: { 'x-ssh-gateway-secret': `${secret}y` } }), false);
    assert.equal(gatewaySecretOk({ headers: {} }), false);
  });
  withEnv({ SSH_GATEWAY_SHARED_SECRET: 'short' }, () => {
    assert.equal(gatewaySecretOk({ headers: { 'x-ssh-gateway-secret': 'short' } }), false);
  });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Duplex } = require('stream');
const { Client } = require('ssh2');
const { createServer } = require('../src/index');
const { FailLimiter, Registry, reapOnce } = require('../src/gateway');

const USER = '65f0aa11bb22cc33dd44ee55';
const GOOD = `oc-${USER}`;

function fakeApi(state) {
  return {
    async verify(username, password) {
      state.verifyCalls += 1;
      if (username === GOOD && password === state.password && !state.revoked)
        return { sessionId: 's1', userId: USER, agentId: 'openclaw', expiresAt: new Date(Date.now() + 60_000).toISOString() };
      return null;
    },
    async active() {
      return state.revoked ? [] : [{ userId: USER, agentId: 'openclaw' }];
    },
  };
}

/** Fake docker whose "exec" echoes back what the client typed, prefixed with the sandbox id. */
function fakeDocker(state) {
  return {
    async ensureSandbox(ident) {
      state.ensured.push(`${ident.agentId}:${ident.userId}`);
      return 'cid';
    },
    async exec(_cid, { cmd, tty }) {
      state.execs.push({ cmd, tty });
      const socket = new Duplex({
        read() {},
        write(chunk, _enc, cb) {
          const text = Buffer.from(`[sandbox:${USER}] ${chunk}`);
          // Non-TTY execs are multiplexed by Docker: 8-byte header per frame.
          const header = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]);
          header.writeUInt32BE(text.length, 4);
          this.push(tty ? text : Buffer.concat([header, text]));
          cb();
        },
        final(cb) {
          this.push(null);
          cb();
        },
      });
      return { execId: 'e1', socket };
    },
    resize: async () => {},
    exitCode: async () => 0,
    listSandboxes: async () => state.containers,
    removeContainer: async (id) => state.removed.push(id),
  };
}

function start(state) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const deps = {
    cfg: { maxConnsPerSandbox: 4, sandbox: { uid: 1000 } },
    api: fakeApi(state),
    docker: fakeDocker(state),
    registry: new Registry(),
    limiter: new FailLimiter(60_000, 5),
    log: () => {},
  };
  const server = createServer(deps, privateKey);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, deps, port: server.address().port })));
}

function connect(port, username, password) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => resolve(c)).on('error', reject);
    c.connect({ host: '127.0.0.1', port, username, password, readyTimeout: 5000, tryKeyboard: false });
  });
}

test('gateway: password auth via API, exec lands in the buyer sandbox, forwarding refused, revoke drops connection', async () => {
  const state = { password: 'pw-1', revoked: false, verifyCalls: 0, ensured: [], execs: [], containers: [], removed: [] };
  const { server, deps, port } = await start(state);
  try {
    await assert.rejects(connect(port, GOOD, 'wrong'), /authentication methods failed/i);
    await assert.rejects(connect(port, 'root', 'pw-1'), /authentication methods failed/i);

    const c = await connect(port, GOOD, 'pw-1');
    const out = await new Promise((resolve, reject) => {
      c.exec('whoami', (err, stream) => {
        if (err) return reject(err);
        let buf = '';
        stream.on('data', (d) => {
          buf += d;
          if (buf.includes('ping')) resolve(buf);
        });
        stream.write('ping');
      });
    });
    assert.match(out, new RegExp(`\\[sandbox:${USER}\\] ping`));
    assert.deepEqual(state.ensured, [`openclaw:${USER}`]);
    assert.deepEqual(state.execs[0].cmd, ['/bin/bash', '-lc', 'whoami']);

    await assert.rejects(
      new Promise((resolve, reject) => c.forwardOut('127.0.0.1', 1, '172.17.0.1', 2375, (e, s) => (e ? reject(e) : resolve(s))))
    );

    // Revoke: the reaper ends the live connection and removes the container.
    state.revoked = true;
    state.containers = [{ id: 'cid', agentId: 'openclaw', userId: USER }];
    const closed = new Promise((resolve) => c.on('close', resolve));
    await reapOnce(deps);
    await closed;
    assert.deepEqual(state.removed, ['cid']);
    await assert.rejects(connect(port, GOOD, 'pw-1'), /authentication methods failed/i);
  } finally {
    server.close();
  }
});

test('reaper keeps active sandboxes and skips the round when the API fails', async () => {
  const removed = [];
  const docker = {
    listSandboxes: async () => [
      { id: 'a', agentId: 'openclaw', userId: USER },
      { id: 'b', agentId: 'openclaw', userId: '1'.repeat(24) },
    ],
    removeContainer: async (id) => removed.push(id),
  };
  const registry = new Registry();
  await reapOnce({ api: { active: async () => [{ agentId: 'openclaw', userId: USER }] }, docker, registry, log: () => {} });
  assert.deepEqual(removed, ['b']);
  await assert.rejects(reapOnce({ api: { active: async () => { throw new Error('down'); } }, docker, registry, log: () => {} }));
  assert.deepEqual(removed, ['b']);
});

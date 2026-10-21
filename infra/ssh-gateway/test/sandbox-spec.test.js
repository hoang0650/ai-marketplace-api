const test = require('node:test');
const assert = require('node:assert/strict');
const spec = require('../src/sandbox-spec');
const { createDemuxer } = require('../src/docker');
const { parseUsername, FailLimiter } = require('../src/gateway');

const ID = { agentId: 'openclaw', userId: '65f0aa11bb22cc33dd44ee55' };
const CFG = {
  image: 'aimarkets/sandbox-base:latest',
  network: 'aim-sbx-net',
  memoryBytes: 512 * 1024 * 1024,
  nanoCpus: 5e8,
  pidsLimit: 128,
  tmpSizeMb: 64,
  runtime: '',
  uid: 1000,
  gid: 1000,
};

test('per-buyer names; invalid identities rejected', () => {
  assert.equal(spec.sandboxName(ID), 'aim-sbx-openclaw-65f0aa11bb22cc33dd44ee55');
  assert.equal(spec.workspaceVolume(ID), 'aim-sbx-openclaw-65f0aa11bb22cc33dd44ee55-ws');
  assert.throws(() => spec.sandboxName({ agentId: 'openclaw', userId: '../etc' }));
  assert.throws(() => spec.sandboxName({ agentId: 'docker', userId: ID.userId }));
});

test('container spec is non-root, capped, no host mounts, no docker socket', () => {
  const s = spec.assertSafeSpec(spec.containerSpec(ID, CFG));
  const h = s.HostConfig;
  assert.equal(s.User, '1000:1000');
  assert.equal(h.Privileged, false);
  assert.deepEqual(h.CapDrop, ['ALL']);
  assert.ok(h.SecurityOpt.includes('no-new-privileges:true'));
  assert.equal(h.ReadonlyRootfs, true);
  assert.deepEqual(h.Binds, []);
  assert.deepEqual(h.Mounts, [{ Type: 'volume', Source: spec.workspaceVolume(ID), Target: '/workspace', ReadOnly: false }]);
  assert.equal(h.NetworkMode, 'aim-sbx-net');
  assert.equal(h.Memory, CFG.memoryBytes);
  assert.equal(h.MemorySwap, CFG.memoryBytes);
  assert.equal(h.PidsLimit, 128);
  assert.ok(!JSON.stringify(s).includes('docker.sock'));
  assert.equal(spec.containerSpec(ID, { ...CFG, runtime: 'runsc' }).HostConfig.Runtime, 'runsc');
});

test('assertSafeSpec rejects dangerous variations', () => {
  const base = () => spec.containerSpec(ID, CFG);
  const bad = [
    (s) => (s.HostConfig.Privileged = true),
    (s) => (s.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock']),
    (s) => s.HostConfig.Mounts.push({ Type: 'bind', Source: '/', Target: '/host' }),
    (s) => s.HostConfig.Mounts.push({ Type: 'volume', Source: 'dokploy-data', Target: '/x' }),
    (s) => (s.HostConfig.NetworkMode = 'host'),
    (s) => (s.HostConfig.PidMode = 'host'),
    (s) => (s.HostConfig.CapAdd = ['SYS_ADMIN']),
    (s) => (s.HostConfig.CapDrop = []),
    (s) => (s.User = 'root'),
    (s) => (s.User = '0:0'),
    (s) => delete s.HostConfig.Memory,
  ];
  for (const mutate of bad) {
    const s = base();
    mutate(s);
    assert.throws(() => spec.assertSafeSpec(s), /unsafe sandbox spec/);
  }
});

test('channel commands', () => {
  assert.deepEqual(spec.channelCommand('shell'), ['/bin/bash', '-l']);
  assert.deepEqual(spec.channelCommand('exec', 'ls -la'), ['/bin/bash', '-lc', 'ls -la']);
  assert.deepEqual(spec.channelCommand('sftp'), ['/usr/lib/openssh/sftp-server']);
  assert.throws(() => spec.channelCommand('x11'));
});

test('username parsing only accepts sandbox logins', () => {
  assert.deepEqual(parseUsername(`oc-${ID.userId}`), ID);
  for (const u of ['root', 'admin', `oc-${ID.userId}\n`, `OC-${ID.userId}`, `xx-${ID.userId}`, '']) assert.equal(parseUsername(u), null);
});

test('docker stream demuxer splits stdout/stderr frames across chunk boundaries', () => {
  const out = [];
  const err = [];
  const push = createDemuxer((d) => out.push(d.toString()), (d) => err.push(d.toString()));
  const frame = (t, s) => Buffer.concat([Buffer.from([t, 0, 0, 0, 0, 0, 0, s.length]), Buffer.from(s)]);
  const all = Buffer.concat([frame(1, 'hello'), frame(2, 'oops'), frame(1, '!')]);
  push(all.subarray(0, 3));
  push(all.subarray(3, 15));
  push(all.subarray(15));
  assert.deepEqual(out, ['hello', '!']);
  assert.deepEqual(err, ['oops']);
});

test('fail limiter blocks an IP after N failures within the window', () => {
  const l = new FailLimiter(1000, 2);
  l.fail('1.1.1.1', 0);
  assert.equal(l.blocked('1.1.1.1', 10), false);
  l.fail('1.1.1.1', 20);
  assert.equal(l.blocked('1.1.1.1', 30), true);
  assert.equal(l.blocked('1.1.1.1', 2000), false);
  assert.equal(l.blocked('2.2.2.2', 30), false);
});

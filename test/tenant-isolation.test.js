const test = require('node:test');
const assert = require('node:assert/strict');
const {
  tenantNames,
  networkSpec,
  containerSpec,
  assertSafeSpec,
  secretDocument,
  secretInjectPlan,
  assertInjectPlan,
  egressAllowlist,
  egressAllowed,
  ensureBuyerContainer,
  stopIdleTenants,
  purgeTenant,
  planMigration,
  assertMigrationSafe,
  VolumeStore,
  redact,
  moderationView,
  buyerRuntimeEnabled,
  runtimeMaintenanceBody,
  IDLE_MS,
  MEMORY_BYTES,
  SHARED_VOLUMES,
} = require('../src/services/tenant-runtime');
const { byokUsageDecision, publicKeySource, KEY_SOURCE_LABELS } = require('../src/services/byok-billing');
const { publicSshSession, passwordStorage } = require('../src/services/ssh-session-public');
const { verifySecret } = require('../src/services/ssh-sandbox');
const { spacebotUnlistedError, spacebotListingFields } = require('../src/services/spacebot-listing');
const { processSubscription } = require('../src/finance/agent-subscription-worker');

const USER_A = '65f0aa11bb22cc33dd44ee55';
const USER_B = '65f0bb22cc33dd44ee55ff66';
const KEY_A = 'sk-user-a-secret-key-aaaa1111';
const KEY_B = 'sk-user-b-secret-key-bbbb2222';
const PLATFORM_KEY = 'sk-platform-must-never-leak-9999';
const RUNTIME_A = 'runtime-token-user-a-0123456789abcd';
const MEMORY_A = 'memory-only-user-a';
const MEMORY_B = 'memory-only-user-b';

function fakeDocker() {
  const volumes = new Map();
  return {
    volumes,
    files: [],
    networks: new Map(),
    containers: new Map(),
    removed: [],
    async ensureNetwork(spec) {
      this.networks.set(spec.Name, spec);
      return { gateway: '10.66.0.1' };
    },
    async ensureVolume(name) {
      if (!volumes.has(name)) volumes.set(name, new Map());
    },
    async ensureContainer(name, spec) {
      this.containers.set(name, spec);
    },
    async start() {},
    async stop(name) {
      const spec = this.containers.get(name);
      if (spec) spec.stopped = true;
    },
    async removeContainer(name) {
      this.containers.delete(name);
      this.removed.push(name);
    },
    async removeVolume(name) {
      volumes.delete(name);
      this.removed.push(name);
    },
    async copyVolume(from, to) {
      if (!volumes.has(from)) throw new Error('missing source');
      volumes.set(to, new Map(volumes.get(from)));
      return { from, to, copied: true };
    },
    async putFile(container, path, contents) {
      this.files.push({ container, path, contents });
    },
  };
}

function records() {
  const rows = [];
  return {
    rows,
    async upsert(record) {
      rows.push(JSON.parse(JSON.stringify(record)));
    },
    async listRunning() {
      return rows.filter((r) => r.state === 'running');
    },
    async markStopped(row) {
      row.state = 'stopped';
    },
  };
}

test('two buyers get distinct containers, volumes and networks', () => {
  const a = tenantNames('hermes', USER_A);
  const b = tenantNames('hermes', USER_B);
  assert.equal(a.container, `aim-agent-hermes-${USER_A}`);
  assert.equal(a.volume, `aim-agent-hermes-${USER_A}-data`);
  assert.equal(a.network, `aim-agent-net-${USER_A}`);
  assert.notEqual(a.container, b.container);
  assert.notEqual(a.volume, b.volume);
  assert.notEqual(a.network, b.network);
  assert.equal(tenantNames('nanoclaw', USER_A).network, a.network);
  assert.notEqual(tenantNames('nanoclaw', USER_A).volume, a.volume);
});

test('container spec is read-only, unprivileged, capped, and has no shared mount', () => {
  const names = tenantNames('hermes', USER_A);
  const spec = assertSafeSpec(
    containerSpec(names, { image: 'example/hermes:tenant', egressProxy: 'http://10.66.0.1:3128' }),
    { volume: names.volume, network: names.network, forbidden: [KEY_A, PLATFORM_KEY] },
  );
  const env = spec.Env.join('\n');
  assert.equal(spec.HostConfig.ReadonlyRootfs, true);
  assert.ok(spec.HostConfig.CapDrop.includes('ALL'));
  assert.ok(spec.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
  assert.equal(spec.HostConfig.Memory, MEMORY_BYTES);
  assert.equal(spec.HostConfig.NanoCpus, 500_000_000);
  assert.equal(spec.HostConfig.PidsLimit, 256);
  assert.equal(spec.HostConfig.Mounts.length, 1);
  assert.equal(spec.HostConfig.Mounts[0].Source, names.volume);
  assert.equal(spec.HostConfig.NetworkMode, names.network);
  assert.equal(env.includes(KEY_A), false);
  assert.equal(env.includes(PLATFORM_KEY), false);
  assert.equal(env.includes('AIMARKETS_SERVICE_SECRET'), false);
  assert.equal(spec.HostConfig.PortBindings['9119/tcp'][0].HostIp, '127.0.0.1');
  const net = networkSpec(USER_A);
  assert.equal(net.Options['com.docker.network.bridge.enable_icc'], 'false');
  assert.equal(net.Options['com.docker.network.bridge.enable_ip_masquerade'], 'false');
});

test('a buyer cannot read another buyer files, memory or keys', async () => {
  const store = new VolumeStore();
  const volA = tenantNames('hermes', USER_A).volume;
  const volB = tenantNames('hermes', USER_B).volume;
  store.write(volA, 'memory.json', MEMORY_A);
  store.write(volA, 'files/notes.txt', 'file-a');
  store.write(volB, 'memory.json', MEMORY_B);
  store.write(volB, 'files/notes.txt', 'file-b');
  assert.equal(store.read('hermes', USER_A, 'memory.json'), MEMORY_A);
  assert.equal(store.read('hermes', USER_B, 'memory.json'), MEMORY_B);
  assert.notEqual(store.read('hermes', USER_A, 'memory.json'), store.read('hermes', USER_B, 'memory.json'));
  assert.equal(store.read('hermes', USER_A, 'files/notes.txt').includes('file-b'), false);
  assert.equal(store.read('nanoclaw', USER_A, 'memory.json'), undefined);

  const docker = fakeDocker();
  const book = records();
  const logs = [];
  await ensureBuyerContainer({
    agentId: 'hermes',
    userId: USER_A,
    secret: { keySource: 'buyer', provider: 'openai', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', apiKey: KEY_A },
    docker,
    image: 'example/hermes:tenant',
    log: (line) => logs.push(line),
    records: book,
  });
  await ensureBuyerContainer({
    agentId: 'hermes',
    userId: USER_B,
    secret: { keySource: 'buyer', provider: 'anthropic', model: 'claude', baseUrl: 'https://api.anthropic.com/v1', apiKey: KEY_B },
    docker,
    image: 'example/hermes:tenant',
    log: (line) => logs.push(line),
    records: book,
  });

  const fileA = docker.files.find((f) => f.container.endsWith(USER_A));
  const fileB = docker.files.find((f) => f.container.endsWith(USER_B));
  assert.equal(fileA.path, '/run/secrets/byok.json');
  assert.equal(fileA.contents.includes(KEY_A), true);
  assert.equal(fileA.contents.includes(KEY_B), false);
  assert.equal(fileB.contents.includes(KEY_A), false);
  assert.equal(fileB.contents.includes(KEY_B), true);
  const specA = docker.containers.get(`aim-agent-hermes-${USER_A}`);
  const specB = docker.containers.get(`aim-agent-hermes-${USER_B}`);
  assert.equal(JSON.stringify(specA).includes(KEY_A), false);
  assert.equal(JSON.stringify(specA).includes(KEY_B), false);
  assert.equal(JSON.stringify(specB).includes(KEY_A), false);
  assert.notEqual(specA.HostConfig.Mounts[0].Source, specB.HostConfig.Mounts[0].Source);
  assert.notEqual(specA.HostConfig.NetworkMode, specB.HostConfig.NetworkMode);
  assert.equal(logs.join('\n').includes(KEY_A), false);
  assert.equal(logs.join('\n').includes(KEY_B), false);
  assert.equal(JSON.stringify(book.rows).includes(KEY_A), false);
  assert.equal(JSON.stringify(book.rows).includes(KEY_B), false);
});

test('platform mode does not put the platform provider key in the container or the allowlist', () => {
  const doc = secretDocument({
    agentId: 'nanoclaw',
    userId: USER_A,
    keySource: 'platform',
    apiKey: RUNTIME_A,
    baseUrl: 'https://api.aimarkets.vn/v1/tenant/openai',
  });
  assert.equal(doc.apiKey, RUNTIME_A);
  assert.equal(JSON.stringify(doc).includes(PLATFORM_KEY), false);
  const plan = assertInjectPlan(secretInjectPlan(doc), RUNTIME_A);
  assert.equal(JSON.stringify(plan.argv).includes(RUNTIME_A), false);
  const allow = egressAllowlist({ keySource: 'platform' });
  assert.equal(egressAllowed('api.aimarkets.vn', allow), true);
  assert.equal(egressAllowed('api.openai.com', allow), false);
  assert.equal(egressAllowed('169.254.169.254', allow), false);
  assert.equal(egressAllowed('10.0.0.5', allow), false);
  const buyer = egressAllowlist({ keySource: 'buyer', provider: 'openai' });
  assert.equal(egressAllowed('api.openai.com', buyer), true);
  assert.equal(egressAllowed('api.anthropic.com', buyer), false);
  const custom = egressAllowlist({
    keySource: 'buyer',
    provider: 'byok-custom',
    baseUrl: 'https://llm.example.com/v1',
  });
  assert.equal(egressAllowed('llm.example.com', custom), true);
  assert.equal(egressAllowed('evil.example', custom), false);
  assert.equal(
    egressAllowlist({ keySource: 'buyer', provider: 'byok-custom', baseUrl: 'http://169.254.169.254/latest' }).has(
      '169.254.169.254',
    ),
    false,
  );
});

test('keys never appear in API response shapes', () => {
  const source = publicKeySource({
    keySource: 'buyer',
    provider: 'openai',
    model: 'gpt-4o',
    last4: '1111',
    apiKey: KEY_A,
  });
  const usage = byokUsageDecision({ keySource: 'buyer', provider: 'openai', model: 'gpt-4o', last4: '1111', apiKey: KEY_A });
  const ssh = publicSshSession({
    _id: 'abc',
    agentId: 'hermes',
    host: 'h',
    port: 22,
    username: 'u',
    command: 'ssh u@h',
    password: KEY_A,
    privateKey: KEY_B,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const view = moderationView(
    {
      agentId: 'hermes',
      userId: USER_A,
      containerName: 'c',
      volumeName: 'v',
      networkName: 'n',
      state: 'running',
      keySource: 'buyer',
      last4: '1111',
      lastActiveAt: new Date().toISOString(),
      apiKey: KEY_A,
      runtimeTokenHash: KEY_B,
    },
    { reason: 'moderation review of this tenant' },
  );
  const blob = JSON.stringify({ source, usage, ssh, view, labels: KEY_SOURCE_LABELS });
  assert.equal(blob.includes(KEY_A), false);
  assert.equal(blob.includes(KEY_B), false);
  assert.equal(blob.includes(PLATFORM_KEY), false);
  assert.equal(usage.charged, 0);
  assert.equal(usage.reason, 'byok');
  assert.equal(usage.keySourceLabel.en, 'Using: your key');
  assert.equal(KEY_SOURCE_LABELS.platform.en, 'Using: AI Markets key');
  assert.equal(KEY_SOURCE_LABELS.buyer.vi.includes('key của bạn'), true);
  assert.equal(KEY_SOURCE_LABELS.platform.zh.includes('AI Markets'), true);
  assert.equal(ssh.password, undefined);
  assert.equal(ssh.privateKey, undefined);
  assert.equal(byokUsageDecision({ keySource: 'platform' }).skip, false);
  const stored = passwordStorage(KEY_A);
  assert.equal(stored.password, undefined);
  assert.equal(stored.passwordHash.includes(KEY_A), false);
  assert.equal(verifySecret(KEY_A, stored.passwordHash), true);
  assert.equal(verifySecret(KEY_B, stored.passwordHash), false);
  assert.equal(redact(`started container ${KEY_A}`, [KEY_A]).includes(KEY_A), false);
});

test('idle containers stop after 15 minutes and a failed backup keeps the volume', async () => {
  assert.equal(IDLE_MS, 15 * 60 * 1000);
  const docker = fakeDocker();
  const book = records();
  const now = new Date('2026-10-31T12:00:00Z');
  book.rows.push(
    { containerName: 'old', state: 'running', lastActiveAt: new Date(now.getTime() - IDLE_MS - 1000) },
    { containerName: 'fresh', state: 'running', lastActiveAt: new Date(now.getTime() - 60_000) },
  );
  docker.containers.set('old', {});
  docker.containers.set('fresh', {});
  const stopped = await stopIdleTenants({ records: book, docker, now });
  assert.deepEqual(stopped, ['old']);
  assert.equal(docker.containers.get('fresh').stopped, undefined);

  docker.volumes.set(tenantNames('nanoclaw', USER_A).volume, new Map([['memory.json', MEMORY_A]]));
  const purged = await purgeTenant({ agentId: 'nanoclaw', userId: USER_A, docker, now });
  assert.equal(docker.volumes.has(purged.backupVolume), true);
  assert.equal(docker.volumes.get(purged.backupVolume).get('memory.json'), MEMORY_A);
  assert.equal(docker.volumes.has(purged.removedVolume), false);
  assert.equal(SHARED_VOLUMES.some((name) => docker.removed.includes(name)), false);

  const stubborn = fakeDocker();
  const volume = tenantNames('hermes', USER_B).volume;
  stubborn.volumes.set(volume, new Map([['memory.json', MEMORY_B]]));
  stubborn.copyVolume = async () => ({ copied: false });
  await assert.rejects(purgeTenant({ agentId: 'hermes', userId: USER_B, docker: stubborn, now }), /source volume kept/);
  assert.equal(stubborn.volumes.has(volume), true);
});

test('migration backs up the shared volume, splits buyers, and never deletes it', () => {
  const plan = assertMigrationSafe(
    planMigration({
      agentId: 'nanoclaw',
      sharedVolume: 'nanoclaw-aimarkets-data',
      paths: [
        `market-${USER_A}/memory.json`,
        `market-${USER_A}/files/a.txt`,
        `${USER_B}/memory.json`,
        'shared/config.json',
      ],
      now: new Date('2026-10-31T00:00:00Z'),
    }),
  );
  assert.equal(plan.deletes.length, 0);
  assert.equal(plan.actions.some((a) => a.op === 'remove-volume' || a.op === 'delete'), false);
  assert.equal(plan.actions[0].op, 'backup-volume');
  assert.equal(plan.actions[0].source, 'nanoclaw-aimarkets-data');
  const copies = plan.actions.filter((a) => a.op === 'copy-path');
  assert.equal(copies.filter((c) => c.userId === USER_A).every((c) => c.destVolume.endsWith(`${USER_A}-data`)), true);
  assert.equal(copies.filter((c) => c.userId === USER_B).every((c) => c.destVolume.endsWith(`${USER_B}-data`)), true);
  assert.equal(copies.some((c) => c.userId === USER_A && c.destVolume.includes(USER_B)), false);
  assert.equal(copies.some((c) => c.sourcePath.includes('shared/config')), false);
  assert.throws(() => planMigration({ agentId: 'spacebot', sharedVolume: 'spacebot-aimarkets-data', paths: [] }), /not a tenant/);
});

test('buyer runtime stays off until the flag is set, and SpaceBot is not listed', async () => {
  const prevH = process.env.HERMES_BUYER_RUNTIME_ENABLED;
  const prevN = process.env.NANOCLAW_BUYER_RUNTIME_ENABLED;
  delete process.env.HERMES_BUYER_RUNTIME_ENABLED;
  delete process.env.NANOCLAW_BUYER_RUNTIME_ENABLED;
  try {
    assert.equal(buyerRuntimeEnabled('hermes'), false);
    assert.equal(buyerRuntimeEnabled('nanoclaw'), false);
    assert.equal(runtimeMaintenanceBody('hermes').code, 'RUNTIME_ISOLATION_MAINTENANCE');
    process.env.HERMES_BUYER_RUNTIME_ENABLED = '1';
    assert.equal(buyerRuntimeEnabled('hermes'), true);
    assert.equal(buyerRuntimeEnabled('nanoclaw'), false);
  } finally {
    if (prevH === undefined) delete process.env.HERMES_BUYER_RUNTIME_ENABLED;
    else process.env.HERMES_BUYER_RUNTIME_ENABLED = prevH;
    if (prevN === undefined) delete process.env.NANOCLAW_BUYER_RUNTIME_ENABLED;
    else process.env.NANOCLAW_BUYER_RUNTIME_ENABLED = prevN;
  }
  const err = spacebotUnlistedError();
  assert.equal(err.status, 403);
  assert.equal(err.code, 'SPACEBOT_UNLISTED');
  assert.equal(spacebotListingFields('spacebot').listed, false);
  assert.equal(spacebotListingFields('hermes').listed, true);
  assert.equal(await processSubscription({ agentId: 'spacebot', user: USER_A }), 'skip');
});

test('moderation requires a reason and does not return secrets', () => {
  assert.throws(
    () =>
      moderationView(
        { agentId: 'hermes', userId: USER_A, containerName: 'c', volumeName: 'v', networkName: 'n', state: 'running' },
        { reason: 'no' },
      ),
    /reason/i,
  );
});

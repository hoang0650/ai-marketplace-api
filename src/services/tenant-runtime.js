const crypto = require('crypto');

/**
 * One container per (buyer, agent) for Hermes and NanoClaw.
 *
 * The container name, data volume and network are derived only from the agent
 * and the buyer id. Nothing here mounts a shared volume, puts a provider key
 * in the image environment, or lets one buyer address another buyer's network.
 * Keys travel through a /run/secrets file written on stdin at start.
 */

const TENANT_AGENTS = Object.freeze(['hermes', 'nanoclaw']);
const USER_ID_RE = /^[a-f0-9]{24}$/;
const LABEL = 'vn.aimarkets.tenant';
const IDLE_MS = 15 * 60 * 1000;
const MEMORY_BYTES = 512 * 1024 * 1024;
const NANO_CPUS = 500_000_000;
const PIDS_LIMIT = 256;
const UID = 1000;

/** Provider hosts a BYOK container may reach, plus the AI Markets API. */
const PROVIDER_HOSTS = Object.freeze({
  openai: ['api.openai.com'],
  anthropic: ['api.anthropic.com'],
  google: ['generativelanguage.googleapis.com'],
  openrouter: ['openrouter.ai'],
  deepseek: ['api.deepseek.com'],
  groq: ['api.groq.com'],
  xai: ['api.x.ai'],
});

const PLATFORM_HOSTS = Object.freeze(['api.aimarkets.vn']);

const AGENT_PORT = Object.freeze({ hermes: 9119, nanoclaw: 3100 });

const RUNTIME_FLAG = Object.freeze({
  hermes: 'HERMES_BUYER_RUNTIME_ENABLED',
  nanoclaw: 'NANOCLAW_BUYER_RUNTIME_ENABLED',
});

const IMAGE_ENV = Object.freeze({
  hermes: 'HERMES_TENANT_IMAGE',
  nanoclaw: 'NANOCLAW_TENANT_IMAGE',
});

function assertIdentity(agentId, userId) {
  const agent = String(agentId || '').toLowerCase();
  const user = String(userId || '').toLowerCase();
  if (!TENANT_AGENTS.includes(agent) || !USER_ID_RE.test(user)) {
    throw new Error('invalid tenant identity');
  }
  return { agentId: agent, userId: user };
}

function tenantNames(agentId, userId) {
  const id = assertIdentity(agentId, userId);
  const base = `aim-agent-${id.agentId}-${id.userId}`;
  return {
    ...id,
    container: base,
    volume: `${base}-data`,
    network: `aim-agent-net-${id.userId}`,
    backupVolume(stamp) {
      const safe = String(stamp || '').replace(/[^0-9A-Za-z-]/g, '');
      if (!safe) throw new Error('backup stamp required');
      return `${base}-backup-${safe}`;
    },
  };
}

function buyerRuntimeEnabled(agentId) {
  const flag = RUNTIME_FLAG[String(agentId || '').toLowerCase()];
  return Boolean(flag) && process.env[flag] === '1';
}

function runtimeMaintenanceBody(agentId) {
  return {
    success: false,
    code: 'RUNTIME_ISOLATION_MAINTENANCE',
    agentId: String(agentId || ''),
    message:
      'This agent is paused while per-user isolation is deployed. Launch stays off until the operator sets the buyer runtime flag.',
  };
}

function agentPort(agentId) {
  return AGENT_PORT[agentId] || 8080;
}

function tenantImage(agentId) {
  const name = IMAGE_ENV[agentId];
  return name ? String(process.env[name] || '').trim() : '';
}

function networkSpec(userId) {
  const id = assertIdentity('hermes', userId);
  return {
    Name: `aim-agent-net-${id.userId}`,
    Driver: 'bridge',
    Internal: false,
    Options: {
      'com.docker.network.bridge.enable_icc': 'false',
      'com.docker.network.bridge.enable_ip_masquerade': 'false',
    },
    Labels: {
      [LABEL]: '1',
      [`${LABEL}.user`]: id.userId,
    },
  };
}

function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.+$/, '');
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function publicHostname(raw) {
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withScheme);
    if (url.protocol !== 'https:') return '';
    const host = url.hostname.toLowerCase();
    if (!host || isPrivateHost(host)) return '';
    return host;
  } catch {
    return '';
  }
}

/**
 * Hosts this container may use. Platform mode only reaches the AI Markets API.
 * BYOK also reaches that provider's public API (or the buyer's https custom host).
 */
function egressAllowlist({ keySource, provider, baseUrl } = {}) {
  const hosts = new Set(PLATFORM_HOSTS);
  if (keySource === 'buyer') {
    const known = PROVIDER_HOSTS[String(provider || '').toLowerCase()] || [];
    for (const host of known) hosts.add(host);
    if (provider === 'byok-custom') {
      const custom = publicHostname(baseUrl);
      if (custom) hosts.add(custom);
    }
  }
  return hosts;
}

function egressAllowed(host, allow) {
  const h = String(host || '')
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.+$/, '');
  if (!h || isPrivateHost(h)) return false;
  return allow instanceof Set ? allow.has(h) : false;
}

function containerSpec(ident, cfg) {
  const id = assertIdentity(ident.agentId, ident.userId);
  const names = tenantNames(id.agentId, id.userId);
  const proxy = String(cfg.egressProxy || '');
  if (!/^http:\/\/[0-9.a-z]+:\d+$/i.test(proxy)) throw new Error('egress proxy required');
  const port = Number(cfg.port || agentPort(id.agentId));
  const env = [
    'HOME=/data',
    'LANG=C.UTF-8',
    `AIMARKETS_AGENT=${id.agentId}`,
    `AIMARKETS_USER_ID=${id.userId}`,
    'AIMARKETS_SECRET_FILE=/run/secrets/byok.json',
    `AIMARKETS_API_URL=${String(cfg.apiUrl || 'https://api.aimarkets.vn').replace(/\/$/, '')}`,
    `HTTP_PROXY=${proxy}`,
    `HTTPS_PROXY=${proxy}`,
    `http_proxy=${proxy}`,
    `https_proxy=${proxy}`,
    'NO_PROXY=127.0.0.1,localhost',
    'no_proxy=127.0.0.1,localhost',
  ];
  if (id.agentId === 'hermes') env.push('HERMES_AIMARKETS_TENANT_ISOLATED=1');
  if (id.agentId === 'nanoclaw') env.push('NANOCLAW_AIMARKETS_TENANT_ISOLATED=1');
  const hostConfig = {
    Privileged: false,
    CapDrop: ['ALL'],
    CapAdd: [],
    SecurityOpt: ['no-new-privileges:true'],
    ReadonlyRootfs: true,
    Init: true,
    Memory: MEMORY_BYTES,
    MemorySwap: MEMORY_BYTES,
    NanoCpus: NANO_CPUS,
    PidsLimit: PIDS_LIMIT,
    Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 2048 }],
    Tmpfs: {
      '/tmp': 'rw,nosuid,nodev,noexec,size=64m',
      '/run': 'rw,nosuid,nodev,noexec,size=8m,mode=0700',
    },
    Mounts: [{ Type: 'volume', Source: names.volume, Target: '/data', ReadOnly: false }],
    Binds: [],
    Devices: [],
    NetworkMode: names.network,
    IpcMode: 'private',
    PidMode: '',
    UsernsMode: '',
    RestartPolicy: { Name: 'no' },
    PortBindings: {
      [`${port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '' }],
    },
    LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '1' } },
  };
  return {
    Image: cfg.image,
    User: `${cfg.uid || UID}:${cfg.gid || UID}`,
    Hostname: id.agentId,
    WorkingDir: '/data',
    Env: env,
    ExposedPorts: { [`${port}/tcp`]: {} },
    Labels: {
      [LABEL]: '1',
      [`${LABEL}.agent`]: id.agentId,
      [`${LABEL}.user`]: id.userId,
    },
    HostConfig: hostConfig,
  };
}

function assertSafeSpec(spec, { volume, network, forbidden = [] } = {}) {
  const h = spec.HostConfig || {};
  const problems = [];
  if (h.Privileged) problems.push('privileged');
  if ((h.Binds || []).length) problems.push('bind mounts');
  if ((h.Devices || []).length) problems.push('devices');
  if (!(h.CapDrop || []).includes('ALL')) problems.push('capabilities not dropped');
  if ((h.CapAdd || []).length) problems.push('cap add');
  if (!((h.SecurityOpt || []).includes('no-new-privileges:true'))) problems.push('new privileges');
  if (h.ReadonlyRootfs !== true) problems.push('writable rootfs');
  if (h.Memory !== MEMORY_BYTES || h.NanoCpus !== NANO_CPUS || h.PidsLimit !== PIDS_LIMIT) {
    problems.push('resource limits');
  }
  if (['host'].includes(h.NetworkMode) || ['host'].includes(h.PidMode) || ['host'].includes(h.IpcMode)) {
    problems.push('host namespace');
  }
  if (h.UsernsMode === 'host') problems.push('host userns');
  if (/^(0|root)(:|$)/.test(String(spec.User || ''))) problems.push('root user');
  if (h.NetworkMode !== network) problems.push('network');
  const mounts = h.Mounts || [];
  if (mounts.length !== 1 || mounts[0].Type !== 'volume' || mounts[0].Source !== volume || mounts[0].Target !== '/data') {
    problems.push('mount');
  }
  const blob = JSON.stringify(spec);
  if (blob.includes('docker.sock')) problems.push('docker socket');
  for (const secret of forbidden) {
    if (secret && String(secret).length >= 8 && blob.includes(String(secret))) problems.push('secret in spec');
  }
  if (problems.length) throw new Error(`unsafe tenant spec: ${problems.join(', ')}`);
  return spec;
}

function secretDocument(fields) {
  const id = assertIdentity(fields.agentId, fields.userId);
  const keySource = fields.keySource === 'buyer' ? 'buyer' : 'platform';
  const apiKey = String(fields.apiKey || '');
  if (apiKey.length < 16) throw new Error('runtime credential missing');
  if (keySource === 'buyer' && !fields.provider) throw new Error('buyer provider missing');
  return {
    v: 1,
    userId: id.userId,
    agent: id.agentId,
    keySource,
    provider: keySource === 'buyer' ? String(fields.provider) : 'aimarkets',
    model: String(fields.model || (keySource === 'platform' ? 'aimarkets-platform' : '')),
    baseUrl: String(fields.baseUrl || ''),
    apiKey,
  };
}

/** argv never carries the secret. The file is written from stdin at mode 0400. */
function secretInjectPlan(document) {
  const body = `${JSON.stringify(document)}\n`;
  return {
    path: '/run/secrets/byok.json',
    mode: 0o400,
    argv: ['/bin/sh', '-c', 'umask 177; cat > /run/secrets/byok.json'],
    stdin: body,
  };
}

function assertInjectPlan(plan, secret) {
  const argv = JSON.stringify(plan.argv);
  if (plan.path !== '/run/secrets/byok.json') throw new Error('secret path');
  if (plan.mode !== 0o400) throw new Error('secret mode');
  if (secret && argv.includes(String(secret))) throw new Error('secret in argv');
  if (!plan.stdin || (secret && !plan.stdin.includes(String(secret)))) throw new Error('secret not in stdin');
  return plan;
}

function redact(text, secrets) {
  let out = String(text ?? '');
  const list = [...secrets].filter((s) => s && String(s).length >= 8).sort((a, b) => String(b).length - String(a).length);
  for (const secret of list) out = out.split(String(secret)).join('[redacted]');
  return out;
}

function hashRuntimeToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function newRuntimeToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * In-memory stand-in for per-tenant volumes. Reads are keyed by the caller's
 * own volume name, so one buyer cannot name another's volume.
 */
class VolumeStore {
  constructor() {
    this.data = new Map();
  }

  write(volume, filePath, content) {
    if (!this.data.has(volume)) this.data.set(volume, new Map());
    this.data.get(volume).set(filePath, content);
  }

  read(agentId, userId, filePath) {
    const { volume } = tenantNames(agentId, userId);
    const files = this.data.get(volume);
    return files ? files.get(filePath) : undefined;
  }
}

function stampFrom(now) {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Start (or reuse) this buyer's container. `secret.apiKey` is the buyer key
 * or a per-container runtime token — never a platform provider key.
 */
async function ensureBuyerContainer({
  agentId,
  userId,
  secret,
  docker,
  image,
  apiUrl,
  now = new Date(),
  log = () => {},
  records,
}) {
  const names = tenantNames(agentId, userId);
  const doc = secretDocument({ ...secret, agentId: names.agentId, userId: names.userId });
  const sink = (message) => log(redact(message, [doc.apiKey]));
  if (!image) throw Object.assign(new Error('tenant image is not configured'), { code: 'TENANT_RUNTIME_UNAVAILABLE' });
  const net = await docker.ensureNetwork(networkSpec(names.userId));
  const gateway = net && net.gateway;
  if (!gateway || !/^\d{1,3}(\.\d{1,3}){3}$/.test(gateway)) {
    throw new Error('tenant network has no gateway');
  }
  await docker.ensureVolume(names.volume);
  const spec = assertSafeSpec(
    containerSpec(names, {
      image,
      egressProxy: `http://${gateway}:3128`,
      apiUrl,
      port: agentPort(names.agentId),
    }),
    { volume: names.volume, network: names.network, forbidden: [doc.apiKey] },
  );
  await docker.ensureContainer(names.container, spec);
  await docker.start(names.container);
  const plan = assertInjectPlan(secretInjectPlan(doc), doc.apiKey);
  await docker.putFile(names.container, plan.path, plan.stdin, plan.mode);
  const record = {
    userId: names.userId,
    agentId: names.agentId,
    containerName: names.container,
    volumeName: names.volume,
    networkName: names.network,
    state: 'running',
    lastActiveAt: now,
    keySource: doc.keySource,
    provider: doc.provider,
    model: doc.model,
    last4: doc.apiKey.slice(-4),
    runtimeTokenHash: doc.keySource === 'platform' ? hashRuntimeToken(doc.apiKey) : '',
  };
  if (records) await records.upsert(record);
  sink(`started ${names.container} keySource=${doc.keySource}`);
  return {
    container: names.container,
    volume: names.volume,
    network: names.network,
    keySource: doc.keySource,
    last4: record.last4,
  };
}

async function stopIdleTenants({ records, docker, now = new Date(), idleMs = IDLE_MS }) {
  const cutoff = now.getTime() - idleMs;
  const rows = await records.listRunning();
  const stopped = [];
  for (const row of rows) {
    if (new Date(row.lastActiveAt).getTime() > cutoff) continue;
    await docker.stop(row.containerName);
    await records.markStopped(row);
    stopped.push(row.containerName);
  }
  return stopped;
}

/**
 * Purge one tenant: copy the data volume to a backup volume, then remove the
 * container and the data volume. Shared volumes are not a valid target.
 */
async function purgeTenant({ agentId, userId, docker, now = new Date(), sharedVolumes = SHARED_VOLUMES }) {
  const names = tenantNames(agentId, userId);
  if (sharedVolumes.includes(names.volume)) throw new Error('refusing to purge a shared volume');
  const backup = names.backupVolume(stampFrom(now));
  const copy = await docker.copyVolume(names.volume, backup);
  if (!copy || copy.copied !== true || copy.to !== backup || copy.from !== names.volume) {
    throw new Error('backup did not complete; source volume kept');
  }
  await docker.stop(names.container);
  await docker.removeContainer(names.container);
  await docker.removeVolume(names.volume);
  return { backupVolume: backup, removedContainer: names.container, removedVolume: names.volume };
}

const SHARED_VOLUMES = Object.freeze([
  'nanoclaw-aimarkets-data',
  'hermes-aimarkets-data',
  'spacebot-aimarkets-data',
  'spacebot-post-limit-recovery-20261029',
]);

const USER_PATH_RE = /^(?:market-)?([a-f0-9]{24})(?:\/(.*))?$/i;

/**
 * Plan a copy of per-user trees out of a shared volume. The shared volume is
 * backed up and never deleted. Paths that are not one buyer's directory stay
 * in the backup only.
 */
function planMigration({ agentId, sharedVolume, paths, now = new Date() }) {
  if (!TENANT_AGENTS.includes(agentId)) throw new Error('agent is not a tenant runtime');
  if (!sharedVolume || SHARED_VOLUMES.includes(sharedVolume) === false && agentId === 'spacebot') {
    throw new Error('unsupported source volume');
  }
  if (sharedVolume.startsWith('aim-agent-')) throw new Error('source is already a tenant volume');
  const backup = `${sharedVolume}-backup-${stampFrom(now)}`;
  const actions = [{ op: 'backup-volume', source: sharedVolume, dest: backup }];
  const seen = new Set();
  for (const raw of paths || []) {
    const rel = String(raw || '').replace(/^\/+/, '');
    const match = USER_PATH_RE.exec(rel);
    if (!match) continue;
    const userId = match[1].toLowerCase();
    const rest = match[2] || '';
    const destVolume = tenantNames(agentId, userId).volume;
    if (!seen.has(destVolume)) {
      seen.add(destVolume);
      actions.push({ op: 'ensure-volume', volume: destVolume, userId });
    }
    actions.push({
      op: 'copy-path',
      sourceVolume: sharedVolume,
      sourcePath: rel,
      destVolume,
      destPath: rest || '.',
      userId,
    });
  }
  const deletes = actions.filter((a) => a.op === 'delete' || a.op === 'remove-volume');
  return { actions, deletes, sharedVolume, backupVolume: backup };
}

function assertMigrationSafe(plan) {
  if (plan.deletes.length) throw new Error('migration must not delete');
  const removed = plan.actions.filter((a) => a.op === 'remove-volume' || a.source === plan.sharedVolume && a.op === 'delete');
  if (removed.length) throw new Error('migration must not delete the shared volume');
  const backups = plan.actions.filter((a) => a.op === 'backup-volume');
  if (backups.length !== 1 || backups[0].source !== plan.sharedVolume) throw new Error('backup missing');
  const copies = plan.actions.filter((a) => a.op === 'copy-path');
  for (const copy of copies) {
    if (copy.destVolume === plan.sharedVolume) throw new Error('copy targets the shared volume');
    if (!copy.destVolume.endsWith(`-${copy.userId}-data`)) throw new Error('copy volume is not the buyer volume');
  }
  return plan;
}

/** Public moderation view. Secrets and runtime tokens are not included. */
function moderationView(record, { reason } = {}) {
  const why = String(reason || '').trim();
  if (why.length < 5) {
    const err = new Error('A reason of at least 5 characters is required.');
    err.status = 400;
    throw err;
  }
  return {
    agentId: record.agentId,
    userId: record.userId,
    container: record.containerName,
    volume: record.volumeName,
    network: record.networkName,
    state: record.state,
    keySource: record.keySource,
    last4: record.last4 || '',
    lastActiveAt: record.lastActiveAt,
    reason: why,
  };
}

module.exports = {
  TENANT_AGENTS,
  LABEL,
  IDLE_MS,
  MEMORY_BYTES,
  NANO_CPUS,
  PIDS_LIMIT,
  PROVIDER_HOSTS,
  PLATFORM_HOSTS,
  SHARED_VOLUMES,
  RUNTIME_FLAG,
  assertIdentity,
  tenantNames,
  buyerRuntimeEnabled,
  runtimeMaintenanceBody,
  agentPort,
  tenantImage,
  networkSpec,
  isPrivateHost,
  publicHostname,
  egressAllowlist,
  egressAllowed,
  containerSpec,
  assertSafeSpec,
  secretDocument,
  secretInjectPlan,
  assertInjectPlan,
  redact,
  hashRuntimeToken,
  newRuntimeToken,
  VolumeStore,
  ensureBuyerContainer,
  stopIdleTenants,
  purgeTenant,
  planMigration,
  assertMigrationSafe,
  moderationView,
};

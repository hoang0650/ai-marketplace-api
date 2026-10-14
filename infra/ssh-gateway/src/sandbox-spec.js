/**
 * Pure builders for the per-buyer sandbox container. Kept side-effect free so
 * the isolation guarantees are unit-tested (no docker socket, no host mounts,
 * non-root, capped resources).
 */
const AGENTS = new Set(['openclaw', 'hermes', 'nanoclaw', 'spacebot']);
const USER_ID_RE = /^[a-f0-9]{24}$/;
const LABEL = 'vn.aimarkets.sandbox';

function assertIdentity({ agentId, userId }) {
  if (!AGENTS.has(agentId) || !USER_ID_RE.test(String(userId))) throw new Error('invalid sandbox identity');
}

function sandboxName(ident) {
  assertIdentity(ident);
  return `aim-sbx-${ident.agentId}-${ident.userId}`;
}

function workspaceVolume(ident) {
  return `${sandboxName(ident)}-ws`;
}

function containerSpec(ident, cfg) {
  assertIdentity(ident);
  const { uid, gid } = cfg;
  const hostConfig = {
    Privileged: false,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    ReadonlyRootfs: true,
    Init: true,
    Memory: cfg.memoryBytes,
    MemorySwap: cfg.memoryBytes,
    NanoCpus: cfg.nanoCpus,
    PidsLimit: cfg.pidsLimit,
    Ulimits: [{ Name: 'nofile', Soft: 4096, Hard: 8192 }],
    Tmpfs: {
      '/tmp': `rw,nosuid,nodev,size=${cfg.tmpSizeMb}m`,
      '/run': 'rw,nosuid,nodev,noexec,size=8m',
    },
    Mounts: [{ Type: 'volume', Source: workspaceVolume(ident), Target: '/workspace', ReadOnly: false }],
    Binds: [],
    Devices: [],
    NetworkMode: cfg.network,
    IpcMode: 'private',
    PidMode: '',
    UsernsMode: '',
    RestartPolicy: { Name: 'no' },
    LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '1' } },
  };
  if (cfg.runtime) hostConfig.Runtime = cfg.runtime;
  return {
    Image: cfg.image,
    User: `${uid}:${gid}`,
    Hostname: `${ident.agentId}-sandbox`,
    WorkingDir: '/workspace',
    Env: ['HOME=/workspace', 'LANG=C.UTF-8', `AIMARKETS_AGENT=${ident.agentId}`],
    Cmd: ['sleep', 'infinity'],
    Labels: { [LABEL]: '1', [`${LABEL}.agent`]: ident.agentId, [`${LABEL}.user`]: ident.userId },
    HostConfig: hostConfig,
  };
}

/** Defence in depth: refuse to create anything that could reach the host. */
function assertSafeSpec(spec) {
  const h = spec.HostConfig || {};
  const problems = [];
  if (h.Privileged) problems.push('privileged');
  if ((h.Binds || []).length) problems.push('bind mounts');
  if ((h.Devices || []).length) problems.push('devices');
  if (!(h.CapDrop || []).includes('ALL')) problems.push('capabilities not dropped');
  if ((h.CapAdd || []).length) problems.push('cap add');
  if (['host'].includes(h.NetworkMode) || ['host'].includes(h.PidMode) || ['host'].includes(h.IpcMode)) problems.push('host namespace');
  if (h.UsernsMode === 'host') problems.push('host userns');
  if (/^(0|root)(:|$)/.test(String(spec.User || ''))) problems.push('root user');
  if (!h.Memory || !h.NanoCpus || !h.PidsLimit) problems.push('missing resource limits');
  for (const m of h.Mounts || []) {
    if (m.Type !== 'volume' || !/^aim-sbx-[a-z]+-[a-f0-9]{24}-ws$/.test(m.Source)) problems.push(`mount ${m.Type}:${m.Source}`);
  }
  if (JSON.stringify(spec).includes('docker.sock')) problems.push('docker socket');
  if (problems.length) throw new Error(`unsafe sandbox spec: ${problems.join(', ')}`);
  return spec;
}

/** Commands run inside the sandbox for each SSH channel type. */
function channelCommand(kind, command) {
  if (kind === 'shell') return ['/bin/bash', '-l'];
  if (kind === 'sftp') return ['/usr/lib/openssh/sftp-server'];
  if (kind === 'exec') return ['/bin/bash', '-lc', String(command || '')];
  throw new Error(`unsupported channel ${kind}`);
}

function identityKey(ident) {
  return `${ident.agentId}:${ident.userId}`;
}

module.exports = { LABEL, sandboxName, workspaceVolume, containerSpec, assertSafeSpec, channelCommand, identityKey };

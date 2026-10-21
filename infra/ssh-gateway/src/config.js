/** Gateway configuration from env. Secrets are read here and never logged. */
function int(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function loadConfig(env = process.env) {
  const cfg = {
    listenPort: int('SSH_GATEWAY_LISTEN_PORT', 2222),
    hostKeyPath: env.SSH_GATEWAY_HOST_KEY || '/data/ssh_host_rsa_key',
    apiBaseUrl: String(env.AIMARKETS_API_URL || 'http://api:3000/v1').replace(/\/+$/, ''),
    apiSecret: String(env.SSH_GATEWAY_SHARED_SECRET || ''),
    dockerHost: env.DOCKER_HOST || 'tcp://docker-proxy:2375',
    reapIntervalMs: int('SANDBOX_REAP_INTERVAL_MS', 60_000),
    maxConnsPerSandbox: int('SANDBOX_MAX_CONNECTIONS', 4),
    authFailWindowMs: int('AUTH_FAIL_WINDOW_MS', 10 * 60_000),
    authFailMax: int('AUTH_FAIL_MAX_PER_IP', 20),
    sandbox: {
      image: env.SANDBOX_IMAGE || 'aimarkets/sandbox-base:latest',
      network: env.SANDBOX_NETWORK || 'aim-sbx-net',
      memoryBytes: int('SANDBOX_MEMORY_MB', 1024) * 1024 * 1024,
      nanoCpus: Math.round(Number(env.SANDBOX_CPUS || 1) * 1e9),
      pidsLimit: int('SANDBOX_PIDS_LIMIT', 256),
      tmpSizeMb: int('SANDBOX_TMP_MB', 256),
      runtime: env.SANDBOX_RUNTIME || '', // e.g. "runsc" (gVisor) when installed
      uid: 1000,
      gid: 1000,
    },
  };
  if (cfg.apiSecret.length < 32) throw new Error('SSH_GATEWAY_SHARED_SECRET must be set (>= 32 chars)');
  return cfg;
}

module.exports = { loadConfig };

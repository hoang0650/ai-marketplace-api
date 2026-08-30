const config = require('../config/env');

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (config.denglishServiceKey) h['X-Service-Key'] = config.denglishServiceKey;
  return h;
}

async function providerFetch(path, { method = 'GET', body, timeoutMs } = {}) {
  const base = (config.denglishApiUrl || '').replace(/\/$/, '');
  if (!base) {
    const err = new Error('DENGLISH_API_URL is not configured');
    err.code = 'PROVIDER_UNAVAILABLE';
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || config.denglishTimeoutMs || 30000);
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.detail || json.message || `provider HTTP ${res.status}`);
      err.status = res.status;
      err.code = typeof json.detail === 'string' ? json.detail : 'PROVIDER_UNAVAILABLE';
      err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function sandboxConnection(serverId, kind = 'game') {
  return {
    ok: true,
    connection: {
      serverId,
      provider: 'runpod',
      status: 'running',
      ssh: null,
      stream: { kind: 'sandbox', host: '127.0.0.1', port: 0, path: '/', tls: false },
    },
    sandbox: true,
  };
}

async function withSandbox(fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    if (config.denglishSandbox) {
      console.warn('[provider] sandbox:', err.message);
      return typeof fallback === 'function' ? fallback(err) : fallback;
    }
    throw err;
  }
}

module.exports = {
  listProviderServers: (provider = 'runpod') =>
    withSandbox(
      () => providerFetch(`/providers/${provider}/servers`),
      {
        ok: true,
        sandbox: true,
        servers: [
          {
            id: 'pod_sandbox_game',
            name: 'GPU Game Lab',
            provider: 'runpod',
            status: 'running',
            gpu: 'NVIDIA RTX 4090 (sandbox)',
            kind: 'game',
          },
        ],
      }
    ),
  createProviderServer: (provider, body) =>
    withSandbox(
      () => providerFetch(`/providers/${provider}/servers`, { method: 'POST', body }),
      {
        ok: true,
        sandbox: true,
        server: {
          id: `pod_sandbox_${Date.now().toString(36)}`,
          name: body?.name || 'GPU Game Lab',
          provider: 'runpod',
          status: 'running',
          gpu: body?.gpuType || 'NVIDIA RTX 4090 (sandbox)',
          kind: body?.kind || 'game',
        },
      }
    ),
  getProviderServer: (provider, id) =>
    withSandbox(
      () => providerFetch(`/providers/${provider}/servers/${encodeURIComponent(id)}`),
      { ok: true, sandbox: true, server: { id, name: 'GPU Game Lab', provider, status: 'running', gpu: 'sandbox', kind: 'game' } }
    ),
  startProviderServer: (provider, id) =>
    withSandbox(() => providerFetch(`/providers/${provider}/servers/${encodeURIComponent(id)}/start`, { method: 'POST' })),
  stopProviderServer: (provider, id) =>
    withSandbox(() => providerFetch(`/providers/${provider}/servers/${encodeURIComponent(id)}/stop`, { method: 'POST' })),
  terminateProviderServer: (provider, id) =>
    withSandbox(() => providerFetch(`/providers/${provider}/servers/${encodeURIComponent(id)}`, { method: 'DELETE' })),
  getConnection: (provider, id) =>
    withSandbox(
      () => providerFetch(`/providers/${provider}/servers/${encodeURIComponent(id)}/connection`),
      sandboxConnection(id)
    ),
  createProviderTerminal: (provider, serverId) =>
    withSandbox(
      () => providerFetch(`/providers/${provider}/terminal`, { method: 'POST', body: { serverId } }),
      { ok: true, sandbox: true, sessionId: `ts_sb_${Date.now().toString(36)}`, serverId, status: 'starting' }
    ),
  closeProviderTerminal: (provider, sessionId) =>
    withSandbox(() =>
      providerFetch(`/providers/${provider}/terminal/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
    ),
  listProviderRegistry: (capability) => {
    const q = capability ? `?capability=${encodeURIComponent(capability)}` : '';
    return withSandbox(() => providerFetch(`/providers/registry${q}`), { ok: true, sandbox: true, providers: null });
  },
};

const config = require('../../config/env');
const { gpuRentalConfig } = require('./config');

/** Stable client-facing codes; upstream messages never leave this module. */
const KNOWN_CODES = new Set([
  'GPU_UNAVAILABLE',
  'PROVIDER_BILLING',
  'PROVIDER_AUTH',
  'PROVIDER_ERROR',
  'PROVIDER_UNAVAILABLE',
  'SERVER_NOT_FOUND',
  'SERVER_NOT_READY',
]);

function providerError(status, code) {
  const safe = KNOWN_CODES.has(code) ? code : 'PROVIDER_ERROR';
  const err = new Error(safe);
  err.status = safe === 'SERVER_NOT_FOUND' ? 404 : safe === 'GPU_UNAVAILABLE' ? 409 : 502;
  err.code = safe;
  err.upstreamStatus = status;
  return err;
}

async function call(path, { method = 'GET', body, timeoutMs = 60_000 } = {}) {
  const base = String(config.denglishApiUrl || '').replace(/\/$/, '');
  if (!base) throw providerError(0, 'PROVIDER_UNAVAILABLE');
  const headers = { 'Content-Type': 'application/json' };
  if (config.denglishServiceKey) headers['X-Service-Key'] = config.denglishServiceKey;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch {
    throw providerError(0, 'PROVIDER_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw providerError(res.status, typeof json.detail === 'string' ? json.detail : '');
  return json;
}

function prefix() {
  return `/providers/${encodeURIComponent(gpuRentalConfig().provider)}`;
}

function sid(id) {
  return encodeURIComponent(String(id || ''));
}

/** Normalized server snapshot (internal). */
function snapshot(server = {}) {
  return {
    id: String(server.id || ''),
    status: String(server.status || 'unknown'),
    costPerHour: Number(server.costPerHour) || 0,
    ready: Boolean(server.ready),
  };
}

// In-memory stand-in used when DENGLISH_SANDBOX is on and the gateway is unreachable (dev/tests).
const sandboxPods = new Map();
const SANDBOX_OFFERS = [
  { id: 'NVIDIA GeForce RTX 4090', name: 'RTX 4090', memoryGb: 24, costPerHour: 0.69, stock: 'High' },
  { id: 'NVIDIA L40S', name: 'L40S', memoryGb: 48, costPerHour: 0.86, stock: 'Medium' },
  { id: 'NVIDIA A100 80GB PCIe', name: 'A100 PCIe', memoryGb: 80, costPerHour: 1.64, stock: 'Low' },
];

async function sandboxed(fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    if (config.denglishSandbox && err.code === 'PROVIDER_UNAVAILABLE') return fallback();
    throw err;
  }
}

async function listGpuTypes() {
  return sandboxed(
    async () => (await call(`${prefix()}/gpu-types`)).gpuTypes || [],
    () => SANDBOX_OFFERS
  );
}

async function createServer(spec) {
  return sandboxed(
    async () => snapshot((await call(`${prefix()}/servers`, { method: 'POST', body: spec, timeoutMs: 120_000 })).server),
    () => {
      const id = `sbx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const offer = SANDBOX_OFFERS.find((o) => o.id === spec.gpuType) || SANDBOX_OFFERS[0];
      const pod = { id, status: 'running', costPerHour: offer.costPerHour * (spec.gpuCount || 1), ready: true };
      sandboxPods.set(id, pod);
      return { ...pod };
    }
  );
}

async function getServer(id) {
  return sandboxed(
    async () => snapshot((await call(`${prefix()}/servers/${sid(id)}`)).server),
    () => {
      const pod = sandboxPods.get(String(id));
      if (!pod) throw providerError(404, 'SERVER_NOT_FOUND');
      return { ...pod };
    }
  );
}

function sandboxSet(id, status) {
  const pod = sandboxPods.get(String(id));
  if (!pod) throw providerError(404, 'SERVER_NOT_FOUND');
  pod.status = status;
  if (status === 'terminated') sandboxPods.delete(String(id));
  return { ...pod };
}

async function startServer(id, gpuCount = 1) {
  return sandboxed(
    async () => snapshot((await call(`${prefix()}/servers/${sid(id)}/start`, { method: 'POST', body: { gpuCount } })).server),
    () => sandboxSet(id, 'running')
  );
}

async function stopServer(id) {
  return sandboxed(
    async () => snapshot((await call(`${prefix()}/servers/${sid(id)}/stop`, { method: 'POST' })).server),
    () => sandboxSet(id, 'stopped')
  );
}

async function terminateServer(id) {
  return sandboxed(
    async () => snapshot((await call(`${prefix()}/servers/${sid(id)}`, { method: 'DELETE' })).server),
    () => {
      sandboxPods.delete(String(id));
      return { id: String(id), status: 'terminated', costPerHour: 0, ready: false };
    }
  );
}

/** HTTPS upstream for one pod port (internal; host never serialized to clients). */
async function httpUpstream(id, port) {
  const json = await call(`${prefix()}/servers/${sid(id)}/http/${Number(port)}`);
  const up = json.upstream || {};
  if (!up.host || !up.port) throw providerError(409, 'SERVER_NOT_READY');
  return { host: String(up.host), port: Number(up.port), tls: up.tls !== false };
}

module.exports = {
  listGpuTypes,
  createServer,
  getServer,
  startServer,
  stopServer,
  terminateServer,
  httpUpstream,
  providerError,
  _sandboxPods: sandboxPods,
};

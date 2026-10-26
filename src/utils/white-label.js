/** Client-facing names for upstream infrastructure; internal adapter keys never leave the API. */
const PUBLIC_PROVIDER = {
  runpod: 'aimarkets-gpu',
  runpod_public: 'aimarkets-endpoints',
  runpod_serverless: 'aimarkets-serverless',
};

/** Region label stored on hosted GPU/game nodes (shown to sellers in the node list). */
const PUBLIC_REGION = 'AI Markets GPU cloud';

function publicProvider(name) {
  if (!name) return undefined;
  const key = String(name).trim().toLowerCase();
  return PUBLIC_PROVIDER[key] || String(name);
}

/** Accept the public alias from clients and resolve it back to the adapter key. */
function internalProvider(name, fallback = 'runpod') {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return fallback;
  const hit = Object.entries(PUBLIC_PROVIDER).find(([, alias]) => alias === key);
  return hit ? hit[0] : key;
}

const PUBLIC_LABEL = {
  runpod: 'AI Markets GPU',
  runpod_public: 'AI Markets Public Endpoints',
  runpod_serverless: 'AI Markets Serverless',
};

/** Registry row as shown to clients (alias key + neutral label). */
function publicRegistryRow(row) {
  if (!row || typeof row !== 'object') return row;
  const key = String(row.provider || '').toLowerCase();
  return {
    ...row,
    provider: publicProvider(row.provider),
    ...(row.adapter ? { adapter: publicProvider(row.adapter) } : {}),
    label: PUBLIC_LABEL[key] || scrubVendor(row.label),
    ...(row.description ? { description: scrubVendor(row.description) } : {}),
  };
}

/** Hosted pods expose upstream ids; only seller-owned external node ids are safe to echo back. */
function publicNodeId(provider, id) {
  return String(provider || '').toLowerCase() === 'external' ? id : undefined;
}

function scrubVendor(text) {
  if (!text) return text;
  return String(text)
    .replace(/\bRunPod\s+(Pods?|pods?)\b/g, 'GPU $1')
    .replace(/\bRunPod\b/gi, 'GPU cloud');
}

const INTERNAL_PAYLOAD_KEYS = ['upstream_cost', 'upstreamCost', 'markup'];

/** Provider payload without our cost basis. */
function publicPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const out = { ...data };
  for (const key of INTERNAL_PAYLOAD_KEYS) delete out[key];
  return out;
}

/** Scrub vendor names anywhere inside a JSON-safe value (error bodies, raw payloads). */
function scrubVendorDeep(value) {
  if (value == null || typeof value !== 'object') return typeof value === 'string' ? scrubVendor(value) : value;
  try {
    return JSON.parse(scrubVendor(JSON.stringify(value)));
  } catch {
    return undefined;
  }
}

module.exports = {
  PUBLIC_REGION,
  publicProvider,
  internalProvider,
  publicNodeId,
  publicRegistryRow,
  publicPayload,
  scrubVendor,
  scrubVendorDeep,
};

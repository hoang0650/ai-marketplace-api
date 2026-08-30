/**
 * White-label public URLs so buyers never see upstream providers (RunPod, etc.).
 * Internal routing still uses UPSTREAM_* env or catalog lookup by model id.
 */

const API_GATEWAY = (process.env.AIMARKETS_API_HOST || 'https://api.aimarkets.vn').replace(/\/$/, '');
const AI_GATEWAY = (process.env.AIMARKETS_AI_HOST || 'https://ai.aimarkets.vn').replace(/\/$/, '');

const PROVIDER_HOST_RE =
  /(api\.runpod\.ai|proxy\.runpod\.net|api\.featherless\.ai|openrouter\.ai|ai-gateway\.vercel\.sh|openai\.com)/i;

function isProviderUrl(url) {
  return !!url && PROVIDER_HOST_RE.test(String(url));
}

function isAimarketsUrl(url) {
  return !!url && /aimarkets\.vn/i.test(String(url));
}

/** Extract RunPod-style id from https://api.runpod.ai/v2/{id}/… */
function extractProviderEndpointId(url) {
  if (!url) return '';
  const m = String(url).match(/\/v2\/([^/]+)\//);
  return m ? m[1] : '';
}

/** Extract model id from https://api.aimarkets.vn/v1/models/{id}/… */
function extractAimarketsModelId(url) {
  if (!url) return '';
  const m = String(url).match(/\/v1\/models\/([^/]+)/i);
  return m ? decodeURIComponent(m[1]) : '';
}

function publicGatewayUrls({ modelId } = {}) {
  const id = encodeURIComponent(String(modelId || 'model').replace(/^runpod-/, '') || 'model');
  return {
    publicEndpoint: `${API_GATEWAY}/v1/models/${id}/runsync`,
    serverlessEndpoint: `${API_GATEWAY}/v1/models/${id}/run`,
    tokenizeEndpoint: `${API_GATEWAY}/v1/models/${id}/tokenize`,
    gatewayUrl: `${AI_GATEWAY}/v1`,
  };
}

/**
 * Mask runtime URL fields for any client-facing payload.
 * Preserves skills/baseModel/etc. Does not touch env secrets.
 */
function maskRuntimeForPublic(runtime, { modelId } = {}) {
  const r = runtime || {};
  const id =
    modelId ||
    extractAimarketsModelId(r.publicEndpoint) ||
    extractAimarketsModelId(r.serverlessEndpoint) ||
    extractProviderEndpointId(r.publicEndpoint) ||
    extractProviderEndpointId(r.serverlessEndpoint) ||
    String(r.baseModel || '')
      .toLowerCase()
      .replace(/\s+/g, '-') ||
    'model';

  const needsMask =
    isProviderUrl(r.publicEndpoint) ||
    isProviderUrl(r.serverlessEndpoint) ||
    isProviderUrl(r.gatewayUrl) ||
    isProviderUrl(r.tokenizeEndpoint) ||
    !r.publicEndpoint;

  if (!needsMask && isAimarketsUrl(r.publicEndpoint || r.serverlessEndpoint || r.gatewayUrl)) {
    return {
      serverlessEndpoint: r.serverlessEndpoint || '',
      tokenizeEndpoint: r.tokenizeEndpoint || '',
      gatewayUrl: r.gatewayUrl || `${AI_GATEWAY}/v1`,
      publicEndpoint: r.publicEndpoint || '',
    };
  }

  const g = publicGatewayUrls({ modelId: id });
  return {
    publicEndpoint: g.publicEndpoint,
    serverlessEndpoint: g.serverlessEndpoint,
    tokenizeEndpoint: r.tokenizeEndpoint && !isProviderUrl(r.tokenizeEndpoint) ? r.tokenizeEndpoint : g.tokenizeEndpoint,
    gatewayUrl: g.gatewayUrl,
  };
}

/** Env helpers for storing real upstream while public fields stay white-labeled. */
function upstreamFromEnv(env = []) {
  const map = Object.fromEntries((env || []).filter((e) => e?.key).map((e) => [e.key, e.value]));
  return {
    runsync: map.UPSTREAM_RUNSYNC || map.UPSTREAM_PUBLIC || '',
    run: map.UPSTREAM_RUN || map.UPSTREAM_SERVERLESS || '',
    gateway: map.UPSTREAM_GATEWAY || '',
    endpointId: map.PROVIDER_ENDPOINT_ID || '',
    provider: map.AI_PROVIDER || '',
  };
}

function withUpstreamEnv(env, { runsync, run, gateway, endpointId, provider }) {
  const list = Array.isArray(env) ? env.map((e) => ({ ...e })) : [];
  const set = (key, value) => {
    if (!value) return;
    const i = list.findIndex((e) => e.key === key);
    if (i >= 0) list[i] = { key, value };
    else list.push({ key, value });
  };
  set('UPSTREAM_RUNSYNC', runsync);
  set('UPSTREAM_RUN', run);
  set('UPSTREAM_GATEWAY', gateway);
  set('PROVIDER_ENDPOINT_ID', endpointId);
  set('AI_PROVIDER', provider || 'runpod_public');
  return list;
}

module.exports = {
  API_GATEWAY,
  AI_GATEWAY,
  isProviderUrl,
  isAimarketsUrl,
  extractProviderEndpointId,
  extractAimarketsModelId,
  publicGatewayUrls,
  maskRuntimeForPublic,
  upstreamFromEnv,
  withUpstreamEnv,
};

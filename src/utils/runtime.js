/**
 * Shared RunPod-style runtime shape for Product (catalog defaults)
 * and Deployment (seller live instance).
 */
function normalizeEnv(raw) {
  if (!raw) return [];
  if (typeof raw === 'string') {
    // Accept .env-style multiline: KEY=VALUE
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const i = line.indexOf('=');
        return {
          key: line.slice(0, i).trim().slice(0, 128),
          value: line.slice(i + 1).trim().slice(0, 4000),
        };
      })
      .filter((e) => e.key)
      .slice(0, 50);
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => ({
      key: String(e?.key || '').trim().slice(0, 128),
      value: String(e?.value ?? '').slice(0, 4000),
    }))
    .filter((e) => e.key)
    .slice(0, 50);
}

function normalizeSkills(raw) {
  if (!raw) return [];
  if (typeof raw === 'string') {
    return raw
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 40);
  }
  if (!Array.isArray(raw)) return [];
  return raw.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 40);
}

function normalizeRuntime(raw = {}, { defaults = {} } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const d = defaults && typeof defaults === 'object' ? defaults : {};
  return {
    serverlessEndpoint: String(src.serverlessEndpoint ?? d.serverlessEndpoint ?? '').trim().slice(0, 500),
    tokenizeEndpoint: String(src.tokenizeEndpoint ?? d.tokenizeEndpoint ?? '').trim().slice(0, 500),
    gatewayUrl: String(src.gatewayUrl ?? d.gatewayUrl ?? '').trim().slice(0, 500),
    publicEndpoint: String(src.publicEndpoint ?? d.publicEndpoint ?? '').trim().slice(0, 500),
    env: normalizeEnv(src.env !== undefined ? src.env : d.env),
    skills: normalizeSkills(src.skills !== undefined ? src.skills : d.skills),
    baseModel: String(src.baseModel ?? d.baseModel ?? '').trim().slice(0, 200),
    systemPrompt: String(src.systemPrompt ?? d.systemPrompt ?? '').slice(0, 4000),
    temperature: Math.min(Math.max(Number(src.temperature ?? d.temperature ?? 0.7) || 0.7, 0), 2),
    maxTokens: Math.min(Math.max(Number(src.maxTokens ?? d.maxTokens ?? 1024) || 1024, 1), 32768),
  };
}

/** Public view — never leak .env secrets. */
function publicRuntime(runtime, { includeSecrets = false } = {}) {
  const r = runtime || {};
  return {
    serverlessEndpoint: r.serverlessEndpoint || '',
    tokenizeEndpoint: r.tokenizeEndpoint || '',
    gatewayUrl: r.gatewayUrl || '',
    publicEndpoint: r.publicEndpoint || '',
    skills: r.skills || [],
    baseModel: r.baseModel || '',
    systemPrompt: r.systemPrompt || '',
    temperature: r.temperature ?? 0.7,
    maxTokens: r.maxTokens ?? 1024,
    ...(includeSecrets
      ? { env: r.env || [] }
      : { envKeys: (r.env || []).map((e) => e.key).filter(Boolean) }),
  };
}

/** Merge patch into existing runtime (partial update). */
function mergeRuntime(existing, patch) {
  if (!patch || typeof patch !== 'object') return normalizeRuntime(existing);
  const base = normalizeRuntime(existing);
  const next = { ...base };
  for (const key of [
    'serverlessEndpoint',
    'tokenizeEndpoint',
    'gatewayUrl',
    'publicEndpoint',
    'baseModel',
    'systemPrompt',
    'temperature',
    'maxTokens',
  ]) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (patch.env !== undefined) next.env = patch.env;
  if (patch.skills !== undefined) next.skills = patch.skills;
  return normalizeRuntime(next);
}

module.exports = {
  normalizeRuntime,
  publicRuntime,
  mergeRuntime,
  normalizeEnv,
  normalizeSkills,
};

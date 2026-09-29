const dns = require('dns').promises;
const net = require('net');

/**
 * BYOK providers exposed to AI Markets OpenClaw buyers.
 * `id` must match the OpenClaw provider id used in openclaw.json model refs.
 */
const BYOK_PROVIDERS = [
  {
    id: 'openai',
    label: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-...',
    verify: { url: 'https://api.openai.com/v1/models', auth: 'bearer' },
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'sk-ant-...',
    verify: {
      url: 'https://api.anthropic.com/v1/models',
      auth: 'header',
      header: 'x-api-key',
      extraHeaders: { 'anthropic-version': '2023-06-01' },
    },
  },
  {
    id: 'google',
    label: 'Google Gemini',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    keyHint: 'AIza...',
    verify: {
      url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
      auth: 'header',
      header: 'x-goog-api-key',
    },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    keyUrl: 'https://openrouter.ai/settings/keys',
    keyHint: 'sk-or-...',
    verify: { url: 'https://openrouter.ai/api/v1/key', auth: 'bearer' },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyHint: 'sk-...',
    verify: { url: 'https://api.deepseek.com/models', auth: 'bearer' },
  },
  {
    id: 'groq',
    label: 'Groq',
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'gsk_...',
    verify: { url: 'https://api.groq.com/openai/v1/models', auth: 'bearer' },
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    keyUrl: 'https://console.x.ai',
    keyHint: 'xai-...',
    verify: { url: 'https://api.x.ai/v1/models', auth: 'bearer' },
  },
  {
    id: 'byok-custom',
    label: 'OpenAI-compatible (custom)',
    keyUrl: '',
    keyHint: '',
    custom: true,
    verify: { path: '/models', auth: 'bearer' },
  },
];

const PROVIDER_BY_ID = new Map(BYOK_PROVIDERS.map((p) => [p.id, p]));

function getByokProvider(id) {
  return PROVIDER_BY_ID.get(String(id || '').trim().toLowerCase()) || null;
}

function publicProviderList() {
  return BYOK_PROVIDERS.map(({ id, label, keyUrl, keyHint, custom }) => ({
    id,
    label,
    keyUrl,
    keyHint,
    custom: Boolean(custom),
  }));
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
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
  const v6 = address.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/**
 * Custom base URLs are fetched by this API and by the OpenClaw gateway, both of
 * which sit on the internal Docker network — only public https hosts are allowed.
 */
async function normalizeCustomBaseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new Error('Base URL không hợp lệ.');
  }
  if (url.protocol !== 'https:') throw new Error('Base URL phải dùng https://');
  if (url.username || url.password) throw new Error('Base URL không được chứa thông tin đăng nhập.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Base URL phải là tên miền công khai.');
  }
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new Error('Không phân giải được tên miền của Base URL.');
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error('Base URL trỏ tới địa chỉ nội bộ, không được phép.');
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

/** Calls a cheap authenticated endpoint; returns { ok, status, message }. */
async function verifyProviderKey(provider, apiKey, baseUrl) {
  const spec = provider.verify;
  const url = provider.custom ? `${baseUrl}${spec.path}` : spec.url;
  const headers = { Accept: 'application/json', ...(spec.extraHeaders || {}) };
  if (spec.auth === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
  else headers[spec.header] = apiKey;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, { headers, redirect: 'error', signal: controller.signal });
    if (res.ok) return { ok: true, status: res.status };
    const body = await res.json().catch(() => ({}));
    const detail = body?.error?.message || body?.message || body?.error || '';
    const message =
      res.status === 401 || res.status === 403
        ? 'API key bị từ chối (sai key hoặc chưa được cấp quyền).'
        : `Provider trả về HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`;
    return { ok: false, status: res.status, message };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      message: aborted ? 'Provider không phản hồi (timeout 12s).' : 'Không kết nối được tới provider.',
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  BYOK_PROVIDERS,
  getByokProvider,
  publicProviderList,
  normalizeCustomBaseUrl,
  verifyProviderKey,
};

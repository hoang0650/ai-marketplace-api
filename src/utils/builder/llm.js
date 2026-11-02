const { getByokProvider } = require('../byok-providers');

/**
 * Streaming chat completions against the buyer's own provider key. Every BYOK provider exposes an
 * OpenAI-compatible /chat/completions endpoint (Anthropic and Gemini included), so one client covers all.
 */

const DEFAULT_MODELS = {
  openai: 'gpt-4.1',
  anthropic: 'claude-sonnet-4-5',
  google: 'gemini-2.5-pro',
  openrouter: 'anthropic/claude-sonnet-4.5',
  deepseek: 'deepseek-chat',
  groq: 'llama-3.3-70b-versatile',
  xai: 'grok-4',
};

/** Output caps some providers enforce below our default. */
const OUTPUT_CAPS = { deepseek: 8192 };

const MODEL_RE = /^[\w.:/@+-]{1,200}$/;

function maxOutputTokens(providerId) {
  const n = Number(process.env.BUILDER_MAX_OUTPUT_TOKENS);
  const want = Number.isFinite(n) && n >= 1024 ? Math.floor(n) : 16000;
  return Math.min(want, OUTPUT_CAPS[providerId] || want);
}

function endpoint(spec, baseUrl) {
  const base = spec.custom ? String(baseUrl || '') : spec.openaiBaseUrl;
  if (!/^https:\/\//i.test(base || '')) return '';
  return base.replace(/\/+$/, '');
}

function bearer(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

function upstreamError(status, body) {
  // A custom provider can echo Authorization in its error body. Return only the
  // status/code so secrets never enter the transcript, UI or application logs.
  const err = new Error(`Provider returned HTTP ${status}`);
  err.status = status;
  err.code = status === 401 || status === 403 ? 'PROVIDER_KEY_REJECTED' : status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_ERROR';
  return err;
}

/**
 * Streams the completion, calling onDelta(text) per chunk; resolves with { text, finishReason, usage }.
 */
async function streamChat({ provider, apiKey, baseUrl, model, messages, signal, onDelta }) {
  const spec = getByokProvider(provider);
  const base = spec ? endpoint(spec, baseUrl) : '';
  if (!base) {
    const err = new Error('Provider has no OpenAI-compatible endpoint');
    err.code = 'PROVIDER_UNSUPPORTED';
    throw err;
  }
  const limit = maxOutputTokens(spec.id);
  const body = {
    model,
    messages,
    stream: true,
    ...(spec.id === 'openai' ? { max_completion_tokens: limit } : { max_tokens: limit }),
  };
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...bearer(apiKey) },
    body: JSON.stringify(body),
    redirect: 'error',
    signal,
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw upstreamError(res.status, json);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finishReason = '';
  let usage = null;
  const handle = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (json.error) throw upstreamError(502, json);
    const choice = json.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta) {
      text += delta;
      onDelta?.(delta);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (json.usage) usage = json.usage;
  };
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer) handle(buffer);
  return { text, finishReason, usage };
}

/** Model ids available to the key (best effort; [] when the provider does not list). */
async function listModels({ provider, apiKey, baseUrl }) {
  const spec = getByokProvider(provider);
  const base = spec ? endpoint(spec, baseUrl) : '';
  if (!base) return [];
  const headers = { Accept: 'application/json' };
  if (spec.id === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    Object.assign(headers, bearer(apiKey));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${base}/models`, { headers, redirect: 'error', signal: controller.signal });
    if (!res.ok) return [];
    const json = await res.json().catch(() => ({}));
    const rows = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    return rows
      .map((m) => String(m.id || m.name || '').replace(/^models\//, ''))
      .filter((id) => MODEL_RE.test(id))
      .slice(0, 300);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { DEFAULT_MODELS, MODEL_RE, maxOutputTokens, streamChat, listModels };

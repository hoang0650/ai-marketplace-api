/**
 * OpenClaw AI Markets pricing: provider COGS × (1 + markup).
 * PHHotel Nest stack models are blocked on the aimarkets surface.
 * Align rates with openclaw/extensions/aimarkets-usage/audience.ts
 */

const AIMARKETS_PROVIDER_MARKUP = Number(process.env.OPENCLAW_AIMARKETS_MARKUP || 0.25);

const PHHOTEL_MODEL_IDS = new Set([
  'deepseek-ai/DeepSeek-V4-Flash',
  'Qwen/Qwen3.6-35B-A3B',
  'MiniMaxAI/MiniMax-M2.5',
]);

/** Featherless / known paid COGS USD per 1M tokens. OpenRouter :free = 0. */
const PROVIDER_RATES = {
  'deepseek-ai/DeepSeek-V4-Flash': { input: 0.14, output: 0.28 },
  'Qwen/Qwen3.6-35B-A3B': { input: 0.2, output: 0.4 },
  'MiniMaxAI/MiniMax-M2.5': { input: 0.295, output: 1.2 },
  default: { input: 0.15, output: 0.6 },
};

function normalizeModelId(model) {
  return String(model || '')
    .trim()
    .replace(/^(featherless|openrouter)\//i, '');
}

function isPhhotelModelId(model) {
  const bare = normalizeModelId(model);
  return PHHOTEL_MODEL_IDS.has(String(model || '').trim()) || PHHOTEL_MODEL_IDS.has(bare);
}

function resolveProviderRate(model) {
  const bare = normalizeModelId(model);
  return PROVIDER_RATES[bare] || PROVIDER_RATES.default;
}

function computeOpenClawSellCost({ model, inputTokens = 0, outputTokens = 0, markup = AIMARKETS_PROVIDER_MARKUP }) {
  const bare = normalizeModelId(model);
  if (/:free$/i.test(bare) || /openrouter\/free/i.test(String(model || ''))) {
    return 0;
  }
  const rate = resolveProviderRate(model);
  const cogs =
    (Math.max(0, Number(inputTokens) || 0) / 1_000_000) * rate.input +
    (Math.max(0, Number(outputTokens) || 0) / 1_000_000) * rate.output;
  const m = Number.isFinite(Number(markup)) ? Number(markup) : AIMARKETS_PROVIDER_MARKUP;
  return Math.round(cogs * (1 + m) * 1e6) / 1e6;
}

module.exports = {
  AIMARKETS_PROVIDER_MARKUP,
  PHHOTEL_MODEL_IDS,
  isPhhotelModelId,
  normalizeModelId,
  computeOpenClawSellCost,
  resolveProviderRate,
};

'use strict';

const { quoteInference } = require('./denglish-client');

/**
 * Ask denglish-api for the exact RunPod payload and the price.
 *
 * `providerCost` is the sell price (RunPod's documented cost plus the configured
 * markup); `upstreamCost` is what RunPod itself charges and is never returned to clients.
 * Falls back to a coarse local guess when denglish-api or the catalog can't help.
 */
async function preflight({ provider, endpointId, model, input }) {
  if (provider === 'runpod_public') {
    try {
      const q = await quoteInference({ model: endpointId || model, input });
      return {
        usage: { unit: q.unit, quantity: q.quantity, total_tokens: 0 },
        providerCost: Number(q.estimatedCost) || 0,
        upstreamCost: Number(q.upstreamCost) || 0,
        markup: Number(q.markup) || 0,
        warnings: q.warnings || [],
      };
    } catch {
      /* denglish-api unavailable — fall through to the local guess */
    }
  }
  const roughTokens = Math.max(1, Math.ceil(JSON.stringify(input || {}).length / 4));
  const unit = input?.duration ? 'seconds' : input?.image && !input?.prompt ? 'images' : 'tokens';
  return {
    usage: {
      unit,
      quantity: input?.duration || (input?.image ? 1 : roughTokens),
      input_tokens: unit === 'tokens' ? roughTokens : 0,
      output_tokens: 0,
      total_tokens: roughTokens,
    },
    providerCost: 0,
    upstreamCost: 0,
    markup: 0,
    warnings: [],
  };
}

module.exports = { preflight };

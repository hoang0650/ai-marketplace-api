const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeOpenClawSellCost,
  isPhhotelModelId,
  AIMARKETS_PROVIDER_MARKUP,
} = require('../src/utils/openclaw-pricing');

test('PHHotel Nest stack models are flagged', () => {
  assert.equal(isPhhotelModelId('MiniMaxAI/MiniMax-M2.5'), true);
  assert.equal(isPhhotelModelId('featherless/deepseek-ai/DeepSeek-V4-Flash'), true);
  assert.equal(isPhhotelModelId('openrouter/openrouter/free'), false);
});

test('OpenRouter free models stay zero cost', () => {
  assert.equal(
    computeOpenClawSellCost({
      model: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
      inputTokens: 100000,
      outputTokens: 50000,
    }),
    0,
  );
});

test('paid Featherless models get +25% markup', () => {
  // MiniMax COGS 0.295/1.2 per 1M → 1M in + 1M out = 1.495 → *1.25 = 1.86875
  const cost = computeOpenClawSellCost({
    model: 'MiniMaxAI/MiniMax-M2.5',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    markup: AIMARKETS_PROVIDER_MARKUP,
  });
  assert.equal(cost, 1.86875);
});

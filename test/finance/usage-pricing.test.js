const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const p = require('../../src/utils/usage-pricing');
const { computeUsageCost, applyAllowedOverrides } = require('../../src/utils/provider-resolve');
const { usageRatePerHour } = require('../../src/utils/compute-session');
const { seedPassword } = require('../../src/utils/seed-password');

const usageProduct = (pricing, over = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  slug: 'llm-x',
  category: 'inference',
  pricing: { model: 'usage', currency: 'USD', ...pricing },
  ...over,
});

describe('usage-pricing helpers', () => {
  test('time units: Vietnamese, "per", "/", numeric prefix and abbreviations', () => {
    const cases = {
      phút: 'minute', 'mỗi phút': 'minute', minute: 'minute', minutes: 'minute', 'per minute': 'minute', '/min': 'minute',
      '1 minute': 'minute', min: 'minute', sec: 'second', second: 'second', giây: 'second', '/s': 'second',
      hour: 'hour', hours: 'hour', giờ: 'hour', 'GPU hour': 'hour', '/hr': 'hour', h: 'hour', day: 'day', ngày: 'day',
    };
    for (const [unit, want] of Object.entries(cases)) assert.equal(p.normalizeTimeUnit(unit), want, unit);
    for (const unit of ['tokens', '1K characters', 'image', '', null]) assert.equal(p.normalizeTimeUnit(unit), null, String(unit));
  });

  test('token unit sizes: 1M / bare tokens per 1M, 1K, per token', () => {
    assert.equal(p.tokenUnitSize('1M tokens'), 1e6);
    assert.equal(p.tokenUnitSize('tokens'), 1e6);
    assert.equal(p.tokenUnitSize('million tokens'), 1e6);
    assert.equal(p.tokenUnitSize('1K tokens'), 1e3);
    assert.equal(p.tokenUnitSize('per token'), 1);
    assert.equal(p.tokenUnitSize('token'), 1);
  });

  test('charCount counts NFC code points (decomposed Vietnamese, emoji)', () => {
    assert.equal(p.charCount('Tiếng Việt'), 10);
    assert.equal(p.charCount('Tie\u0302\u0301ng'), 5); // decomposed ế → 1 char after NFC
    assert.equal(p.charCount('😀a'), 2); // surrogate pair is one character
    assert.equal(p.charCount(''), 0);
    assert.equal(p.charCount(null), 0);
  });

  test('toUsd converts VND with the shared 26,500 default', () => {
    assert.equal(p.vndPerUsd({}), 26500);
    assert.equal(p.vndPerUsd({ VND_USD_RATE: '25000' }), 25000);
    assert.equal(p.toUsd(26500, 'VND', 26500), 1);
    assert.equal(p.toUsd(2, 'usd'), 2);
  });
});

describe('computeUsageCost', () => {
  const tok = (input, output) => ({ unit: 'tokens', input_tokens: input, output_tokens: output, total_tokens: input + output });

  test('1M-token listings divide by 1,000,000 (was /1000 → 1000× overcharge)', () => {
    const prod = usageProduct({ usageUnit: '1M tokens', usageRate: 2 });
    assert.equal(computeUsageCost(prod, tok(400_000, 100_000)), 1);
  });

  test('bare "tokens" is per 1M; "1K tokens" per thousand', () => {
    assert.equal(computeUsageCost(usageProduct({ usageUnit: 'tokens', usageRate: 0.15 }), tok(1_000_000, 0)), 0.15);
    assert.equal(computeUsageCost(usageProduct({ usageUnit: '1K tokens', usageRate: 0.5 }), tok(2000, 0)), 1);
  });

  test('separate input / output prices', () => {
    const prod = usageProduct({ usageUnit: '1M tokens', usageRate: 1, inputRate: 3, outputRate: 15 });
    assert.equal(computeUsageCost(prod, tok(1_000_000, 100_000)), 4.5);
    const onlyOut = usageProduct({ usageUnit: '1M tokens', usageRate: 1, outputRate: 4 });
    assert.equal(computeUsageCost(onlyOut, tok(1_000_000, 1_000_000)), 5);
  });

  test('VND-priced listings are converted to USD', () => {
    const prod = usageProduct({ usageUnit: '1M tokens', usageRate: 26500, currency: 'VND' });
    assert.equal(computeUsageCost(prod, tok(1_000_000, 0)), 1);
  });

  test('voice: NFC characters, empty text costs 0 (no 1-char minimum)', () => {
    const voice = usageProduct({ usageUnit: '1K characters', usageRate: 1 }, { category: 'voice-clone' });
    assert.equal(computeUsageCost(voice, { unit: 'characters' }, { prompt: 'Tie\u0302\u0301ng' }), 0.005);
    assert.equal(computeUsageCost(voice, { unit: 'characters' }, { prompt: '😀😀' }), 0.002);
    assert.equal(computeUsageCost(voice, { unit: 'characters', quantity: 0 }, { prompt: '' }), 0);
  });

  test('sandbox usage is never billed', () => {
    const prod = usageProduct({ usageUnit: '1M tokens', usageRate: 2 });
    assert.equal(computeUsageCost(prod, { ...tok(1_000_000, 0), sandbox: true }, {}, 5), 0);
  });

  test('seconds usage on a per-minute listing scales to minutes', () => {
    const prod = usageProduct({ usageUnit: 'phút', usageRate: 0.6 });
    assert.equal(computeUsageCost(prod, { unit: 'seconds', quantity: 30 }), 0.3);
  });
});

describe('usageRatePerHour (game / compute streaming)', () => {
  const rate = (pricing) => usageRatePerHour({ pricing: { model: 'usage', currency: 'USD', ...pricing } });
  test('normalizes phút / per minute / /min / 1 minute / sec / day', () => {
    assert.equal(rate({ usageUnit: 'phút', usageRate: 0.05 }), 3);
    assert.equal(rate({ usageUnit: 'per minute', usageRate: 0.05 }), 3);
    assert.equal(rate({ usageUnit: '/min', usageRate: 0.05 }), 3);
    assert.equal(rate({ usageUnit: '1 minute', usageRate: 0.05 }), 3);
    assert.equal(rate({ usageUnit: 'sec', usageRate: 0.001 }), 3.6);
    assert.equal(rate({ usageUnit: 'day', usageRate: 24 }), 1);
    assert.equal(rate({ usageUnit: 'GPU hour', usageRate: 1.2 }), 1.2);
  });
  test('VND listings → USD/hour', () => {
    assert.equal(rate({ usageUnit: 'phút', usageRate: 1325, currency: 'VND' }), 3);
  });
});

describe('buyer overrides', () => {
  const resolved = { provider: 'openrouter', model: 'openai/gpt-4o-mini', endpointId: '' };
  const prod = usageProduct({ usageUnit: '1M tokens', usageRate: 0.15 }, { slug: 'openrouter-gpt-4o-mini', runtime: { baseModel: 'openai/gpt-4o-mini' } });

  test('provider / model / endpoint outside the listing allowlist are ignored', () => {
    const r = applyAllowedOverrides(prod, resolved, { provider: 'runpod_public', model: 'anthropic/claude-opus', endpointId: 'someone-elses-endpoint' });
    assert.equal(r.provider, 'openrouter');
    assert.equal(r.model, 'openai/gpt-4o-mini');
    assert.equal(r.endpointId, '');
    assert.deepEqual(r.ignored.sort(), ['endpointId', 'model', 'provider']);
    assert.equal(r.rerouted, false);
  });

  test('the listing slug / base model are not a reroute; allowlisted models are honoured', () => {
    assert.equal(applyAllowedOverrides(prod, resolved, { model: 'openrouter-gpt-4o-mini' }).rerouted, false);
    const multi = { ...prod, runtime: { ...prod.runtime, allowedModels: ['openai/gpt-4o'] } };
    const r = applyAllowedOverrides(multi, resolved, { model: 'openai/gpt-4o' });
    assert.equal(r.model, 'openai/gpt-4o');
    assert.equal(r.rerouted, true);
  });
});

describe('seed passwords', () => {
  test('no shared default: random unless SEED_PASSWORD (>= 12 chars) is set', () => {
    const a = seedPassword({});
    const b = seedPassword({});
    assert.notEqual(a, b);
    assert.ok(a.length >= 24);
    assert.notEqual(seedPassword({ SEED_PASSWORD: 'short' }), 'short');
    assert.equal(seedPassword({ SEED_PASSWORD: 'a-long-operator-secret' }), 'a-long-operator-secret');
  });
});

describe('deployment proxy metering (computeCost)', () => {
  const { _computeCost } = require('../../src/routes/deployments');
  test('uses the same unit / split / currency rules as the playground', () => {
    const prod = usageProduct({ usageUnit: '1M tokens', usageRate: 1, inputRate: 2, outputRate: 8, currency: 'VND' });
    assert.equal(_computeCost({ ...prod, pricing: { ...prod.pricing, currency: 'USD' } }, 1_500_000, 1_000_000, 500_000), 6);
    assert.equal(_computeCost(prod, 1_500_000, 1_000_000, 500_000), Math.round((6 / 26500) * 1e6) / 1e6);
    assert.equal(_computeCost(usageProduct({ usageUnit: '1K tokens', usageRate: 0.5 }), 4000), 2);
    assert.equal(_computeCost({ pricing: { model: 'fixed', price: 9 } }, 1000), 0);
  });
});

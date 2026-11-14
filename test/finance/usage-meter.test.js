const test = require('node:test');
const assert = require('node:assert/strict');
const { computeUsageCost, explainUsageCharge } = require('../../src/utils/provider-resolve');
const {
  measureGatewayUsage,
  billMeasuredUsage,
  describeUsageUnit,
  ROUNDING_ID,
} = require('../../src/finance/usage-units');
const { usageListingError } = require('../../src/routes/products');
const { mapUsageEvent } = require('../../src/utils/buyer-usage');

const product = (pricing, category = 'inference') => ({
  category,
  pricing: { model: 'usage', currency: 'USD', usageRate: 1, ...pricing },
});

const tokens = (input, output, extra = {}) => ({
  input_tokens: input,
  output_tokens: output,
  total_tokens: input + output,
  ...extra,
});

test('every metered unit bills pro-rata and money rounds half-up to 1e-6 USD', () => {
  assert.equal(computeUsageCost(product({ usageUnit: '1_token', usageRate: 0.000001, inputRate: 0.000003, outputRate: 0.000015 }), tokens(1000, 100)), 0.0045);
  assert.equal(computeUsageCost(product({ usageUnit: '1k_tokens', usageRate: 0.5 }), tokens(2000, 0)), 1);
  assert.equal(computeUsageCost(product({ usageUnit: '1m_tokens', usageRate: 2 }), tokens(400_000, 100_000)), 1);

  const chars = measureGatewayUsage({
    unit: '1m_characters',
    category: 'voice-clone',
    input: { prompt: 'a'.repeat(2500) },
  });
  assert.equal(chars.count, 2500);
  assert.equal(billMeasuredUsage({ unit: '1m_characters', rate: 2, measurement: chars }).costUsd, 0.005);

  assert.equal(billMeasuredUsage({
    unit: '1_second',
    rate: 0.02,
    measurement: { count: 1.5 },
  }).costUsd, 0.03);

  const ninety = measureGatewayUsage({
    unit: '1_minute',
    category: 'text-to-video',
    output: { duration_seconds: 90 },
    upstreamUsage: { quantity: 2 },
  });
  assert.equal(ninety.count, 90);
  assert.equal(billMeasuredUsage({ unit: '1_minute', rate: 0.6, measurement: ninety }).costUsd, 0.9);

  const hour = measureGatewayUsage({
    unit: '1_hour',
    category: 'text-to-video',
    output: { duration_seconds: 90 },
  });
  assert.equal(billMeasuredUsage({ unit: '1_hour', rate: 1.2, measurement: hour }).costUsd, 0.03);

  assert.equal(computeUsageCost(product({ usageUnit: '1_request', usageRate: 0.02 }, 'api-endpoint'), {}), 0.02);
  assert.equal(computeUsageCost(product({ usageUnit: '1_image', usageRate: 0.04 }, 'text-to-image'), {
    output: { images: ['a', 'b', 'c'] },
  }), 0.12);

  assert.equal(billMeasuredUsage({
    unit: '1_token',
    rate: 0.0000005,
    measurement: { count: 1, inputTokens: 1 },
  }).costUsd, 0.000001);
  assert.equal(billMeasuredUsage({
    unit: '1_token',
    rate: 0.0000004,
    measurement: { count: 1, inputTokens: 1 },
  }).costUsd, 0);
});

test('cached input tokens are removed from input and billed at cachedInputRate', () => {
  const usage = {
    prompt_tokens: 1000,
    completion_tokens: 200,
    prompt_tokens_details: { cached_tokens: 800 },
  };
  const measured = measureGatewayUsage({ unit: '1m_tokens', category: 'inference', upstreamUsage: usage });
  assert.equal(measured.inputTokens, 200);
  assert.equal(measured.cachedTokens, 800);
  assert.equal(measured.outputTokens, 200);
  assert.equal(measured.count, 1200);
  assert.equal(billMeasuredUsage({
    unit: '1m_tokens',
    rate: 1,
    inputRate: 3,
    outputRate: 15,
    cachedInputRate: 0.3,
    measurement: measured,
  }).costUsd, 0.00384);

  const anthropic = measureGatewayUsage({
    unit: '1k_tokens',
    category: 'text-to-text',
    upstreamUsage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 800 },
  });
  assert.equal(anthropic.inputTokens, 200);
  assert.equal(anthropic.cachedTokens, 800);

  const clamped = measureGatewayUsage({
    unit: '1_token',
    category: 'api-endpoint',
    upstreamUsage: { input_tokens: 100, output_tokens: 0, cached_tokens: 150 },
  });
  assert.equal(clamped.cachedTokens, 100);
  assert.equal(clamped.inputTokens, 0);

  const omitted = computeUsageCost(product({
    usageUnit: '1M tokens',
    usageRate: 1,
    inputRate: 3,
    outputRate: 15,
  }), usage);
  assert.equal(omitted, 0.006);

  const legacy = computeUsageCost(product({
    usageUnit: '1M tokens',
    usageRate: 1,
    inputRate: 3,
    outputRate: 15,
    cachedInputRate: 0.3,
  }), usage);
  assert.equal(legacy, 0.00384);

  const freeCache = computeUsageCost(product({
    usageUnit: '1_token',
    usageRate: 0.000002,
    cachedInputRate: 0,
  }), tokens(1000, 0, { cached_tokens: 800 }));
  assert.equal(freeCache, 0.0004);
});

test('seller runtime usage is trusted only on the upstream response and inside bounds', () => {
  const reported = measureGatewayUsage({
    unit: '1_image',
    category: 'text-to-image',
    input: { quantity: 9, usage: { report: { unit: 'image', quantity: 10 } }, report: { unit: 'image', quantity: 10 } },
    upstreamUsage: { quantity: 9, report: { unit: 'image', quantity: 3 } },
    output: { images: ['only-server'] },
  });
  assert.equal(reported.count, 3);
  assert.equal(reported.sellerReported, true);
  assert.equal(reported.ignoredClientQuantity, true);

  const emptyReport = measureGatewayUsage({
    unit: '1_image',
    category: 'text-to-image',
    upstreamUsage: { report: { unit: 'image', quantity: 0 } },
    output: { images: ['a', 'b'] },
  });
  assert.equal(emptyReport.count, 2);

  const tooMany = measureGatewayUsage({
    unit: '1_image',
    category: 'text-to-image',
    upstreamUsage: { report: { unit: 'image', quantity: 100 } },
    output: { images: ['a'] },
  });
  assert.equal(tooMany.count, 1);
  assert.equal(tooMany.sellerReported, undefined);

  const wrongDimension = measureGatewayUsage({
    unit: '1k_tokens',
    category: 'inference',
    upstreamUsage: { input_tokens: 10, output_tokens: 0, report: { unit: 'image', quantity: 4 } },
  });
  assert.equal(wrongDimension.count, 10);

  const header = measureGatewayUsage({
    unit: '1_second',
    category: 'text-to-video',
    upstreamUsage: { 'x-aim-usage': '{"unit":"second","quantity":12}' },
  });
  assert.equal(header.count, 12);

  const overClock = measureGatewayUsage({
    unit: '1_second',
    category: 'gpu-compute',
    elapsedMs: 10_000,
    upstreamUsage: { report: { unit: 'second', quantity: 30 } },
  });
  assert.equal(overClock.count, 10);
  assert.equal(overClock.sellerReported, undefined);

  const flat = explainUsageCharge(product({
    usageUnit: '1_token',
    usageRate: 0.000002,
    inputRate: 0.00001,
    outputRate: 0.00001,
  }), { report: { unit: 'token', quantity: 1500 } });
  assert.equal(flat.costUsd, 0.003);
  assert.equal(flat.sellerReported, true);

  const split = explainUsageCharge(product({
    usageUnit: '1m_tokens',
    usageRate: 1,
    inputRate: 3,
    outputRate: 15,
    cachedInputRate: 0.3,
  }), { report: { unit: '1k_tokens', input: 1000, output: 200, cached: 800 } });
  assert.equal(split.costUsd, 0.00384);
  assert.equal(split.inputTokens, 200);
  assert.equal(split.cachedTokens, 800);
});

test('non-2xx and explicit failures are not billed, and minCharge is a floor only when something was measured', () => {
  const priced = product({ usageUnit: '1_request', usageRate: 0.05, minCharge: 0.01 });
  assert.equal(computeUsageCost(priced, { http_status: 502, report: { unit: 'request', quantity: 1 } }), 0);
  assert.equal(computeUsageCost(priced, { ok: false }), 0);
  assert.equal(computeUsageCost(priced, { billable: false }), 0);
  assert.equal(computeUsageCost(priced, {}), 0.05);

  const tiny = explainUsageCharge(product({ usageUnit: '1_request', usageRate: 0.001, minCharge: 0.01 }), {});
  assert.equal(tiny.costUsd, 0.01);
  assert.equal(tiny.rounding, ROUNDING_ID);

  const empty = explainUsageCharge(product({ usageUnit: '1_image', usageRate: 0.5, minCharge: 0.01 }, 'text-to-image'), {
    output: { images: [] },
  });
  assert.equal(empty.costUsd, 0);
});

test('existing usageRate listings keep their token and hour meaning without a migration', () => {
  assert.equal(computeUsageCost(product({ usageUnit: 'tokens', usageRate: 0.15 }), tokens(1_000_000, 0)), 0.15);
  assert.equal(computeUsageCost(product({ usageUnit: 'per token', usageRate: 0.000002 }), tokens(1000, 500)), 0.003);
  assert.equal(computeUsageCost(product({ usageUnit: 'hour', usageRate: 1.2 }), { unit: 'seconds', quantity: 1800 }), 0.6);
  assert.equal(computeUsageCost(product({ usageUnit: 'GPU hour', usageRate: 1.2 }, 'gpu-compute'), { unit: 'seconds', quantity: 3600 }), 1.2);

  const described = describeUsageUnit({ model: 'usage', usageUnit: 'tokens', usageRate: 0.15 }, 'api-endpoint');
  assert.equal(described.usageUnit, 'tokens');
  assert.equal(described.meter.unit, '1m_tokens');
  assert.equal(described.meter.rate, 0.15);
  assert.equal(described.meter.rounding, ROUNDING_ID);
});

test('listing accepts unit and rate aliases and rejects a negative price', () => {
  const pricing = { model: 'usage', unit: '1k_chars', rate: 0.02, cachedInputRate: 0.001, minCharge: 0.01 };
  assert.equal(usageListingError('voice-clone', pricing), null);
  assert.equal(pricing.usageUnit, '1k_characters');
  assert.equal(pricing.usageRate, 0.02);
  assert.equal(usageListingError('inference', { model: 'usage', unit: 'token', rate: 0.000002 }), null);
  assert.equal(usageListingError('inference', { model: 'usage', usageUnit: '1_token', usageRate: -1 }).code, 'USAGE_RATE_INVALID');
  assert.equal(usageListingError('text-to-image', { model: 'usage', unit: 'minute', rate: 1 }).code, 'USAGE_UNIT_NOT_METERABLE');
});

test('buyer usage history exposes quantity, unit, rate and amount', () => {
  const row = mapUsageEvent({
    _id: 'e1',
    unit: '1k_tokens',
    quantity: 1500,
    rate: 0.5,
    cost: 0.75,
    currency: 'USD',
    inputTokens: 1000,
    outputTokens: 500,
    cachedTokens: 200,
    rawUsage: {
      bill: {
        rate: 0.5,
        currency: 'USD',
        inputRate: 0.4,
        outputRate: 1.2,
        cachedInputRate: 0.1,
        rounding: ROUNDING_ID,
      },
    },
    createdAt: new Date('2026-11-14T00:00:00.000Z'),
    product: { _id: 'p1', name: 'Qwen', slug: 'qwen' },
  });
  assert.equal(row.quantity, 1500);
  assert.equal(row.unit, '1k_tokens');
  assert.equal(row.rate, 0.5);
  assert.equal(row.rateCurrency, 'USD');
  assert.equal(row.inputRate, 0.4);
  assert.equal(row.outputRate, 1.2);
  assert.equal(row.cachedInputRate, 0.1);
  assert.equal(row.amount, 0.75);
  assert.equal(row.rounding, ROUNDING_ID);
});

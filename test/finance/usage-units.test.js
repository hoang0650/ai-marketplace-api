const test = require('node:test');
const assert = require('node:assert/strict');
const { computeUsageCost } = require('../../src/utils/provider-resolve');
const { canOpenDispute, effectiveSellerNet } = require('../../src/utils/payout-hold');
const {
  usageUnitCatalog,
  migrateUsageUnit,
  applyUsageUnitMigration,
  assertUsageListing,
  measureGatewayUsage,
  billMeasuredUsage,
  accessPeriodEnd,
  ROUNDING_ID,
} = require('../../src/finance/usage-units');
const { escrowSlice, escrowRefundPlan } = require('../../src/finance/service-escrow');
const { normalizeServicePackages, selectServicePackage, normalizePaymentChoice } = require('../../src/utils/hire/packages');
const { usageListingError } = require('../../src/routes/products');

const usageProduct = (pricing, category = 'inference') => ({
  category,
  pricing: { model: 'usage', currency: 'USD', usageRate: 1, ...pricing },
});

test('the unit catalog is a fixed enum with VI and EN labels', () => {
  const catalog = usageUnitCatalog();
  const codes = catalog.units.map((unit) => unit.code);
  for (const code of ['1k_characters', '1m_characters', '1k_tokens', '1m_tokens', '1_second', '1_minute', '1_hour', '1_request', '1_image', '1_day', '1_week', '1_month', '1_year']) {
    assert.equal(codes.includes(code), true, code);
  }
  const day = catalog.units.find((unit) => unit.code === '1_day');
  assert.equal(day.kind, 'entitlement');
  assert.equal(day.dimension, 'access_period');
  assert.equal(day.labelVi, '1 ngày');
  assert.equal(catalog.rounding.id, ROUNDING_ID);
  assert.equal(catalog.allowedByCategory['text-to-image'].includes('1k_tokens'), false);
  assert.equal(catalog.allowedByCategory['text-to-image'].includes('1_image'), true);
  assert.equal(catalog.allowedByCategory['gpu-compute'].includes('1_day'), false);
  assert.equal(catalog.allowedByCategory['gpu-compute'].includes('1_hour'), true);
});

test('listings reject free text and units the endpoint cannot meter', () => {
  assert.equal(assertUsageListing('text-to-text', '1K tokens').code, 'USAGE_UNIT_INVALID');
  assert.equal(assertUsageListing('text-to-image', '1k_tokens').code, 'USAGE_UNIT_NOT_METERABLE');
  assert.equal(assertUsageListing('voice-clone', '1k_characters'), null);
  assert.equal(usageListingError('inference', { model: 'usage', usageUnit: 'requests' }).code, 'USAGE_UNIT_INVALID');
  assert.equal(usageListingError('inference', { model: 'one-time', usageUnit: 'nope' }), null);
});

test('unambiguous free text migrates and the rest is flagged', () => {
  assert.equal(migrateUsageUnit('1K tokens', 'inference').usageUnit, '1k_tokens');
  assert.equal(migrateUsageUnit('tokens', 'api-endpoint').usageUnit, '1m_tokens');
  assert.equal(migrateUsageUnit('1K characters', 'voice-clone').status, 'canonical');
  assert.equal(migrateUsageUnit('phút', 'game-server').usageUnit, '1_minute');
  assert.equal(migrateUsageUnit('GPU hour', 'gpu-compute').usageUnit, '1_hour');
  assert.equal(migrateUsageUnit('sec', 'text-to-video').usageUnit, '1_second');
  assert.equal(migrateUsageUnit('per image', 'text-to-image').usageUnit, '1_image');
  assert.equal(migrateUsageUnit('month', 'story-book').usageUnit, '1_month');
  assert.equal(migrateUsageUnit('megapixel', 'text-to-image').status, 'needs_review');
  assert.equal(migrateUsageUnit('video', 'text-to-video').status, 'needs_review');
  assert.equal(migrateUsageUnit('day', 'gpu-compute').status, 'needs_review');
  assert.equal(migrateUsageUnit('per token', 'inference').status, 'needs_review');
  assert.equal(migrateUsageUnit('1K characters', 'text-to-image').status, 'needs_review');
  assert.equal(migrateUsageUnit('1K characters', 'voice-clone', { charactersPerCredit: 100 }).status, 'needs_review');

  const listing = { category: 'inference', pricing: { model: 'usage', usageUnit: '1M tokens', usageRate: 2 } };
  assert.equal(applyUsageUnitMigration(listing).usageUnit, '1m_tokens');
  assert.equal(listing.pricing.usageUnitLegacy, '1M tokens');
  const odd = { category: 'text-to-image', pricing: { usageUnit: 'megapixel' } };
  assert.equal(applyUsageUnitMigration(odd).status, 'needs_review');
  assert.equal(odd.pricing.usageUnit, 'megapixel');
});

test('metering ignores client quantity and bills pro-rata', () => {
  const measured = measureGatewayUsage({
    unit: '1k_tokens',
    category: 'inference',
    input: { prompt: 'hello', quantity: 999999, duration: 999999 },
    upstreamUsage: { quantity: 999999, input_tokens: 2000, output_tokens: 0, total_tokens: 999999 },
  });
  assert.equal(measured.count, 2000);
  assert.equal(measured.ignoredClientQuantity, true);
  assert.equal(billMeasuredUsage({ unit: '1k_tokens', rate: 0.5, measurement: measured }).costUsd, 1);

  const chars = measureGatewayUsage({
    unit: '1k_characters',
    category: 'voice-clone',
    input: { prompt: 'abcd', quantity: 5000 },
    upstreamUsage: { quantity: 5000, unit: 'characters' },
  });
  assert.equal(chars.count, 4);
  assert.equal(billMeasuredUsage({ unit: '1k_characters', rate: 1, measurement: chars }).costUsd, 0.004);

  const minutes = measureGatewayUsage({
    unit: '1_minute',
    category: 'text-to-video',
    input: { duration: 999 },
    upstreamUsage: { quantity: 999, unit: 'seconds' },
    output: { duration_seconds: 30 },
  });
  assert.equal(minutes.count, 30);
  assert.equal(billMeasuredUsage({ unit: '1_minute', rate: 0.6, measurement: minutes }).costUsd, 0.3);

  const ignoredDuration = measureGatewayUsage({
    unit: '1_minute',
    category: 'text-to-video',
    input: { duration: 120 },
    upstreamUsage: { quantity: 120 },
  });
  assert.equal(ignoredDuration.count, 0);

  const images = measureGatewayUsage({
    unit: '1_image',
    category: 'text-to-image',
    input: { quantity: 9 },
    upstreamUsage: { quantity: 9 },
    output: { images: ['a', 'b'] },
  });
  assert.equal(images.count, 2);

  assert.equal(computeUsageCost(usageProduct({ usageUnit: '1k_tokens', usageRate: 0.5 }), {
    quantity: 999999,
    input_tokens: 2000,
    output_tokens: 0,
  }), 1);
  assert.equal(computeUsageCost(usageProduct({ usageUnit: '1_day', usageRate: 3 }, 'api-endpoint'), {
    input_tokens: 5000,
    output_tokens: 5000,
  }), 0);
});

test('missing provider tokens use the server character estimate, not the client count', () => {
  const measured = measureGatewayUsage({
    unit: '1m_tokens',
    category: 'text-to-text',
    input: { messages: [{ content: 'abcd' }], usage: { total_tokens: 999 } },
    upstreamUsage: { quantity: 999 },
    output: { text: 'efgh' },
  });
  assert.equal(measured.estimated, true);
  assert.equal(measured.inputTokens, 1);
  assert.equal(measured.outputTokens, 1);
});

test('access periods are calendar entitlements', () => {
  const start = new Date('2026-11-11T00:00:00Z');
  assert.equal(accessPeriodEnd(start, 'day').toISOString(), '2026-11-12T00:00:00.000Z');
  assert.equal(accessPeriodEnd(start, 'week').toISOString(), '2026-11-18T00:00:00.000Z');
  assert.equal(accessPeriodEnd(start, 'month').toISOString(), '2026-12-11T00:00:00.000Z');
  assert.equal(accessPeriodEnd(start, 'year').toISOString(), '2027-11-11T00:00:00.000Z');
});

test('compute time uses the server clock and not a client duration', () => {
  const measured = measureGatewayUsage({
    unit: '1_hour',
    category: 'gpu-compute',
    input: { duration: 10 },
    upstreamUsage: { quantity: 10 },
    elapsedMs: 1800 * 1000,
  });
  assert.equal(measured.count, 1800);
  assert.equal(billMeasuredUsage({ unit: '1_hour', rate: 1.2, measurement: measured }).costUsd, 0.6);
});

test('service packages and the two payment choices', () => {
  const bad = normalizeServicePackages([{ name: 'Shoot', price: 10 }]);
  assert.equal(bad.error.code, 'SERVICE_PACKAGE_FIELDS');
  const ok = normalizeServicePackages([{
    name: 'Half day',
    scope: 'One location, edited set',
    deliverables: ['30 edited photos'],
    durationDays: 7,
    price: 150,
  }]);
  assert.equal(ok.packages[0].code, 'half-day');
  assert.equal(ok.packages[0].price, 150);
  const product = { name: 'Photo', pricing: { price: 10 }, servicePackages: ok.packages };
  assert.throws(() => selectServicePackage(product, ''), /SERVICE_PACKAGE_REQUIRED/);
  assert.equal(selectServicePackage(product, 'half-day').price, 150);
  assert.equal(normalizePaymentChoice(undefined), 'staged');
  assert.equal(normalizePaymentChoice('prepaid'), 'prepaid');
  assert.throws(() => normalizePaymentChoice('bank'), /PAYMENT_CHOICE_INVALID/);
});

test('prepaid escrow releases on acceptance and refunds do not claw unreleased net', () => {
  const first = escrowSlice({ plannedSellerNet: 80, total: 100, milestoneAmount: 30, releasedSellerNet: 0, isLast: false });
  assert.equal(first.netSlice, 24);
  const last = escrowSlice({ plannedSellerNet: 80, total: 100, milestoneAmount: 40, releasedSellerNet: 56, isLast: true });
  assert.equal(last.netSlice, 24);

  const beforeAcceptance = escrowRefundPlan({ gross: 100, releasedSellerNet: 0, refundGross: 100 });
  assert.equal(beforeAcceptance.buyerCredit, 100);
  assert.equal(beforeAcceptance.sellerDebit, 0);
  const afterRelease = escrowRefundPlan({ gross: 100, releasedSellerNet: 24, refundGross: 100 });
  assert.equal(afterRelease.sellerDebit, 24);

  const held = { status: 'paid', amount: 100, disputeStatus: 'none', sellerNetAmount: 80, escrow: { status: 'held', releasedSellerNet: 0 } };
  assert.equal(canOpenDispute(held, new Date('2027-01-01')), true);
  assert.equal(effectiveSellerNet(held), 0);
  const released = { status: 'paid', amount: 100, disputeStatus: 'none', sellerNetAmount: 24, payoutHoldUntil: new Date('2026-11-01'), escrow: { status: 'partial', releasedSellerNet: 24 } };
  assert.equal(effectiveSellerNet(released), 24);
});

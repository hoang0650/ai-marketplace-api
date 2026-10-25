const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildGameServerProducts } = require('../../src/data/game-server-products');
const { dedicatedRatePerHour } = require('../../src/utils/game-hosting');
const { runningUsage } = require('../../src/utils/game-billing');

test('listed per-minute rate equals what a session on the typical pod bills per minute', () => {
  const mc = buildGameServerProducts().find((p) => p.slug === 'game-server-minecraft-java');
  const sessionPerMinute = Math.round((dedicatedRatePerHour(0.08, mc.gameServer.diskGb) / 60) * 1e6) / 1e6;
  assert.equal(mc.pricing.usageRate, sessionPerMinute);
});

test('running usage counts the partial minute and estimates the charge in cents', () => {
  const now = new Date('2026-10-25T10:00:00Z');
  const s = { dedicated: true, status: 'live', readyAt: new Date(now - 2 * 60_000 - 5_000), billedCost: 0 };
  assert.deepEqual(runningUsage(s, 0.105781, now), { usedMinutes: 3, usedCost: 0.005289, estimatedCharge: 0.01 });
  assert.equal(runningUsage({ ...s, status: 'stopped' }, 0.105781, now), null);
  assert.equal(runningUsage({ ...s, readyAt: null, status: 'starting' }, 0.105781, now), null);
  // Never shows less than what the wallet was already charged.
  assert.equal(runningUsage({ ...s, billedCost: 0.02 }, 0.105781, now).estimatedCharge, 0.02);
});

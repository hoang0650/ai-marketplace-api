const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const aimx = require('../../src/utils/aimx-gpu');
const { decide, studioPolicy } = require('../../src/utils/studio-policy');
const training = require('../../src/routes/training-jobs');

describe('aimx 5090 launch promo', () => {
  it('is on only when the flag is set and the end date has not passed', () => {
    assert.equal(aimx.promoActive({}), false);
    assert.equal(aimx.promoActive({ GPU_FREE_PROMO: 'true' }), true);
    assert.equal(aimx.promoActive({ GPU_FREE_PROMO: 'true', GPU_FREE_PROMO_UNTIL: '2026-12-31T00:00:00Z' }, new Date('2026-10-17T00:00:00Z')), true);
    assert.equal(aimx.promoActive({ GPU_FREE_PROMO: 'true', GPU_FREE_PROMO_UNTIL: '2026-10-01T00:00:00Z' }, new Date('2026-10-17T00:00:00Z')), false);
  });
  it('prices the shared offer at 0 during the promo and at list price after', () => {
    assert.equal(aimx.sharedOffer({ GPU_FREE_PROMO: '1', GPU_5090_PRICE_PER_HOUR: '0.9' }).pricePerHour, 0);
    const off = aimx.sharedOffer({ GPU_5090_PRICE_PER_HOUR: '0.9' });
    assert.equal(off.pricePerHour, 0.9); assert.equal(off.promo.active, false);
  });
  it('bills per started minute when the promo is off', () => {
    assert.equal(aimx.trainingCharge(30, 0.6), 0.01);
    assert.equal(aimx.trainingCharge(600, 0.6), 0.1);
  });
  it('never charges studio jobs during the promo but keeps a daily cap', () => {
    const policy = studioPolicy({ STUDIO_FREE_FAST_PER_DAY: '2', STUDIO_PROMO_PER_DAY: '5' });
    assert.deepEqual(decide({ kind: 'fast', usedToday: 3, available: 0, policy, promo: true }).charge, 0);
    assert.equal(decide({ kind: 'fast', usedToday: 5, available: 99, policy, promo: true }).status, 429);
    assert.equal(decide({ kind: 'tts', usedToday: 0, available: 0, policy, promo: true }).free, true);
  });
  it('records the start time on the first running report', () => {
    const doc = { status: 'queued', startedAt: null };
    training.applyReport(doc, { status: 'running' });
    assert.equal(doc.status, 'running'); assert.ok(doc.startedAt instanceof Date);
  });
});

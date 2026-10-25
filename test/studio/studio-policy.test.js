const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { decide, dayStart, studioPolicy } = require('../../src/utils/studio-policy');

const policy = studioPolicy({ STUDIO_FREE_FAST_PER_DAY: '2', STUDIO_PRICE_FAST_USD: '0.05', STUDIO_FREE_TALKING_PER_DAY: '1', STUDIO_PRICE_TALKING_USD: '0' });

describe('studio policy', () => {
  it('gives free jobs until the daily quota is used', () => {
    assert.deepEqual(decide({ kind: 'fast', usedToday: 0, available: 0, policy }), { ok: true, free: true, charge: 0, remainingFree: 1 });
    assert.equal(decide({ kind: 'fast', usedToday: 1, available: 0, policy }).free, true);
  });
  it('charges the wallet after the quota when balance allows', () => {
    const d = decide({ kind: 'fast', usedToday: 2, available: 1, policy });
    assert.equal(d.ok, true); assert.equal(d.free, false); assert.equal(d.charge, 0.05);
  });
  it('rejects with 402 when the wallet is too low', () => {
    const d = decide({ kind: 'fast', usedToday: 2, available: 0.01, policy });
    assert.equal(d.status, 402); assert.equal(d.code, 'INSUFFICIENT_WALLET');
  });
  it('rejects with 429 when paid use is disabled (price 0)', () => {
    assert.equal(decide({ kind: 'talking', usedToday: 1, available: 99, policy }).status, 429);
  });
  it('rejects unknown kinds', () => {
    assert.equal(decide({ kind: 'x', usedToday: 0, available: 0, policy }).status, 400);
  });
  it('computes the day start in UTC+7', () => {
    const d = dayStart(new Date('2026-10-17T16:30:00Z'));
    assert.equal(d.toISOString(), '2026-10-16T17:00:00.000Z');
    assert.equal(dayStart(new Date('2026-10-17T17:30:00Z')).toISOString(), '2026-10-17T17:00:00.000Z');
  });
  it('the studio router loads', () => {
    const r = require('../../src/routes/studio');
    assert.equal(typeof r, 'function');
  });
});

describe('studio TTS per-character billing', () => {
  const { ttsCharge } = require('../../src/utils/studio-policy');
  const p = studioPolicy({ STUDIO_FREE_TTS_PER_DAY: '2', STUDIO_PRICE_TTS_PER_1K_CHARS_USD: '0.01', STUDIO_PRICE_TTS_MIN_USD: '0.0005' });
  it('prices by NFC characters with a per-job minimum', () => {
    assert.equal(ttsCharge(1000, p.tts), 0.01);
    assert.equal(ttsCharge(2000, p.tts), 0.02);
    assert.equal(ttsCharge(150, p.tts), 0.0015);
    assert.equal(ttsCharge(10, p.tts), 0.0005);
    assert.equal(ttsCharge(0, p.tts), 0);
  });
  it('is free within the daily quota, then charges by length', () => {
    assert.equal(decide({ kind: 'tts', usedToday: 1, available: 0, policy: p, chars: 1500 }).charge, 0);
    const d = decide({ kind: 'tts', usedToday: 2, available: 1, policy: p, chars: 1500 });
    assert.equal(d.ok, true); assert.equal(d.free, false); assert.equal(d.charge, 0.015);
    assert.equal(decide({ kind: 'tts', usedToday: 2, available: 0.001, policy: p, chars: 1500 }).code, 'INSUFFICIENT_WALLET');
  });
  it('counts Vietnamese with combining marks once per letter', () => {
    const { charCount } = require('../../src/utils/usage-pricing');
    assert.equal(charCount('Xin chào'.normalize('NFD')), 8);
  });
  it('legacy STUDIO_PRICE_TTS_USD still sets the per-1K rate', () => {
    assert.equal(studioPolicy({ STUDIO_PRICE_TTS_USD: '0.02' }).tts.perKChars, 0.02);
  });
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decide, studioPolicy } = require('../../src/utils/studio-policy');
const { failMessage } = require('../../src/utils/studio-errors');
const aimxTts = require('../../src/utils/aimx-tts');

test('film has its own small promo cap and never charges during promo', () => {
  const p = studioPolicy({});
  assert.equal(decide({ kind: 'film', usedToday: 2, available: 0, policy: p, promo: true }).charge, 0);
  assert.equal(decide({ kind: 'film', usedToday: 3, available: 100, policy: p, promo: true }).code, 'FREE_QUOTA_EXHAUSTED');
  assert.equal(decide({ kind: 'fast', usedToday: 3, available: 0, policy: p, promo: true }).ok, true);
});

test('film billing when promo is off', () => {
  const p = studioPolicy({});
  assert.equal(decide({ kind: 'film', usedToday: 0, available: 0, policy: p }).free, true);
  assert.equal(decide({ kind: 'film', usedToday: 1, available: 1, policy: p }).charge, 0.3);
  assert.equal(decide({ kind: 'film', usedToday: 1, available: 0.1, policy: p }).code, 'INSUFFICIENT_WALLET');
});

test('film failure label', () => {
  assert.match(failMessage('film', 'worker HTTP 500', false), /^Tạo phim AI thất bại: /);
});

test('playground voice language defaults to Vietnamese (VieNeu)', () => {
  assert.equal(aimxTts.langOf({}), 'vi');
  assert.equal(aimxTts.langOf({ language: 'zh-CN' }), 'zh');
  assert.equal(aimxTts.langOf({ lang: 'xx' }), 'vi');
  assert.equal(aimxTts.VIENEU_MODEL, 'pnnbao-ump/VieNeu-TTS');
});

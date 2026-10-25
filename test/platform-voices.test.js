const test = require('node:test');
const assert = require('node:assert');
const { findPresetVoice } = require('../src/data/vieneu-voices');
const { platformVoiceDefs, platformVoiceProduct, PLATFORM_VOICE_RATE_PER_1K } = require('../src/data/platform-voices');
const { normalizeContentMeta } = require('../src/utils/license-keys');
const { voiceInferInput } = require('../src/utils/voice-clone');

test('preset roster matches the worker voices and maps retired v3-Turbo names', () => {
  assert.strictEqual(findPresetVoice('Ngọc').id, 'Ngoc');
  assert.strictEqual(findPresetVoice('truc-ly').id, 'Ly');
  assert.strictEqual(findPresetVoice('Thục Đoan').id, 'Doan');
  assert.strictEqual(findPresetVoice('Adam'), null);
});

test('platform voice listings: 6 VieNeu + Chatterbox default, usage-priced, languages declared', () => {
  const defs = platformVoiceDefs();
  assert.deepStrictEqual(defs.map((d) => d.presetVoiceId), ['Binh', 'Tuyen', 'Ly', 'Ngoc', 'Vinh', 'Doan', 'default']);
  const cb = platformVoiceProduct(defs[6]);
  assert.strictEqual(cb.category, 'voice-preset');
  assert.ok(!cb.contentMeta.voiceLanguages.includes('vi'));
  assert.strictEqual(cb.pricing.usageRate, PLATFORM_VOICE_RATE_PER_1K);
  assert.match(cb.license, /MIT/);
  const ly = platformVoiceProduct(defs[2]);
  assert.strictEqual(ly.contentMeta.voiceLanguages[0], 'vi');
  assert.match(ly.license, /Apache-2\.0/);
  assert.match(ly.license, /CC-BY-NC/);
  assert.match(ly.description, /English/);
  assert.match(ly.description, /中文/);
});

test('preset contentMeta keeps the demo clip and the served languages', () => {
  const meta = normalizeContentMeta('voice-preset', {
    presetVoiceId: 'Ly', voiceSampleUrl: 'https://cdn.example/ly.mp3', voiceLanguages: ['vi', 'EN'], voiceEngine: 'vieneu',
  });
  assert.strictEqual(meta.voiceSampleUrl, 'https://cdn.example/ly.mp3');
  assert.deepStrictEqual(meta.voiceLanguages, ['vi', 'en']);
});

test('preset TTS input sends the worker voice id', () => {
  const out = voiceInferInput({ category: 'voice-preset', contentMeta: { presetVoiceId: 'Ngoc', presetVoiceName: 'Ngọc' } }, { prompt: 'xin chào' });
  assert.strictEqual(out.voice, 'Ngoc');
});

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { localSandboxInfer } = require('../../src/utils/denglish-client');
const { computeUsageCost, resolveProviderForProduct } = require('../../src/utils/provider-resolve');
const { applyVoiceCloneToProduct, voiceTtsInput, VOICE_CLONE_ENDPOINT } = require('../../src/utils/voice-clone');
const { isVoiceProduct, voiceSampleUrl, putVoiceAudio, getVoiceAudio } = require('../../src/utils/voice-audio');

describe('voice clone playground', () => {
  test('sandbox returns mp3 audio, not text', () => {
    const out = localSandboxInfer({
      category: 'voice-clone',
      model: 'mai-linh-narrator',
      voiceSampleUrl: 'https://example.com/mai-linh.mp3',
      input: { prompt: 'xin chao' },
    });
    assert.equal(out.data.kind, 'audio');
    assert.equal(out.data.format, 'mp3');
    assert.equal(out.data.audio_url, 'https://example.com/mai-linh.mp3');
    assert.equal(out.usage.unit, 'characters');
    assert.equal(out.usage.quantity, 'xin chao'.length);
  });

  test('usage bills 1K characters', () => {
    const product = {
      category: 'voice-clone',
      pricing: { model: 'usage', usageRate: 0.02, usageUnit: '1K characters' },
    };
    const cost = computeUsageCost(product, { unit: 'characters', quantity: 2000 }, { prompt: 'hi' });
    assert.equal(cost, 0.04);
  });

  test('seller MP3 becomes chatterbox clone runtime', () => {
    const product = applyVoiceCloneToProduct({
      category: 'voice-clone',
      contentMeta: { voiceSampleUrl: 'https://cdn.example/me.mp3' },
    });
    assert.equal(product.contentMeta.cloneStatus, 'ready');
    assert.equal(product.contentMeta.cloneEndpoint, VOICE_CLONE_ENDPOINT);
    assert.equal(product.infraProvider, 'runpod_public');
    const env = Object.fromEntries((product.runtime.env || []).map((e) => [e.key, e.value]));
    assert.equal(env.AI_PROVIDER, 'runpod_public');
    assert.equal(env.PROVIDER_ENDPOINT_ID, VOICE_CLONE_ENDPOINT);
    assert.equal(env.VOICE_SAMPLE_URL, 'https://cdn.example/me.mp3');
    const tts = voiceTtsInput(product, { prompt: 'xin chao', id: 'reuse-me', idempotencyKey: 'dup' });
    assert.equal(tts.audio_url, 'https://cdn.example/me.mp3');
    assert.equal(tts.prompt, 'xin chao');
    assert.equal(tts.id, undefined);
    assert.equal(tts.idempotencyKey, undefined);
    assert.deepEqual(resolveProviderForProduct(product), {
      provider: 'runpod_public',
      endpointId: VOICE_CLONE_ENDPOINT,
      model: VOICE_CLONE_ENDPOINT,
    });
  });

  test('sample url and audio cache', () => {
    assert.equal(isVoiceProduct({ category: 'voice-clone' }), true);
    assert.match(voiceSampleUrl({ contentMeta: {} }), /\.mp3$/);
    putVoiceAudio('abc', Buffer.from('ID3'), 'audio/mpeg');
    const row = getVoiceAudio('abc');
    assert.equal(row.contentType, 'audio/mpeg');
    assert.equal(row.buffer.length, 3);
  });
});

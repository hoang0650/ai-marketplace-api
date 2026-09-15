const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { localSandboxInfer } = require('../../src/utils/denglish-client');
const { computeUsageCost, resolveProviderForProduct } = require('../../src/utils/provider-resolve');
const { applyVoiceCloneToProduct, voiceTtsInput, VOICE_CLONE_MODEL } = require('../../src/utils/voice-clone');
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

  test('seller MP3 becomes VieNeu clone runtime', () => {
    const product = applyVoiceCloneToProduct({
      category: 'voice-clone',
      contentMeta: { voiceSampleUrl: 'https://cdn.example/me.mp3' },
    });
    assert.equal(product.contentMeta.cloneStatus, 'ready');
    assert.equal(product.contentMeta.cloneEndpoint, VOICE_CLONE_MODEL);
    assert.equal(product.infraProvider, 'runpod_serverless');
    const env = Object.fromEntries((product.runtime.env || []).map((e) => [e.key, e.value]));
    assert.equal(env.AI_PROVIDER, 'runpod_serverless');
    assert.equal(env.VOICE_SAMPLE_URL, 'https://cdn.example/me.mp3');
    const tts = voiceTtsInput(product, { prompt: 'xin chao', id: 'reuse-me', idempotencyKey: 'dup' });
    assert.equal(tts.audio_url, 'https://cdn.example/me.mp3');
    assert.equal(tts.action, 'voice_clone');
    assert.equal(tts.prompt, 'xin chao');
    assert.equal(tts.id, undefined);
    assert.equal(tts.idempotencyKey, undefined);
    assert.deepEqual(resolveProviderForProduct(product), {
      provider: 'runpod_serverless',
      endpointId: '',
      model: VOICE_CLONE_MODEL,
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

  test('STT uses PhoWhisper and ignores seller clone MP3', () => {
    const {
      isVoiceSttRequest,
      voiceSttInput,
      voiceInferInput,
      STT_MODEL,
    } = require('../../src/utils/voice-clone');
    const product = {
      category: 'voice-clone',
      contentMeta: { voiceSampleUrl: 'https://cdn.example/me.mp3', voiceSource: 'clone' },
    };
    assert.equal(isVoiceSttRequest({ action: 'stt', audio_base64: 'abc' }), true);
    assert.equal(isVoiceSttRequest({ prompt: 'hello' }), false);
    const stt = voiceSttInput(product, { action: 'stt', audio_base64: 'abc', audio_url: 'https://cdn.example/me.mp3' });
    assert.equal(stt.action, 'stt');
    assert.equal(stt.audio_url, '');
    assert.equal(stt.stt_model, STT_MODEL);
    assert.equal(stt.tts, false);
    const routed = voiceInferInput(product, { action: 'stt', audio_base64: 'abc' });
    assert.equal(routed.action, 'stt');
    const sandbox = localSandboxInfer({
      category: 'voice-preset',
      input: { action: 'stt', audio_base64: 'abc' },
    });
    assert.equal(sandbox.data.kind, 'text');
    assert.equal(sandbox.usage.unit, 'characters');
  });

  test('platform preset TTS does not send a clone sample', () => {
    const { voiceTtsInput } = require('../../src/utils/voice-clone');
    const tts = voiceTtsInput(
      { category: 'voice-preset', contentMeta: { presetVoiceName: 'Ngọc Huyền', voiceSource: 'preset' } },
      { prompt: 'xin chào' },
    );
    assert.equal(tts.action, 'tts');
    assert.equal(tts.voice, 'Ngọc Huyền');
    assert.equal(tts.voice_mode, 'preset');
    assert.equal(tts.audio_url, '');
  });
});

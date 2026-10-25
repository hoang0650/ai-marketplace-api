const { publicGatewayUrls, withUpstreamEnv } = require('./gateway-urls');
const {
  isVoiceCategory,
  isVoiceCloneCategory,
  isVoicePresetCategory,
  normalizeContentMeta,
} = require('./license-keys');
const { findPresetVoice } = require('../data/vieneu-voices');

const VOICE_CLONE_MODEL = 'pnnbao-ump/VieNeu-TTS-v3-Turbo';
const STT_MODEL = 'vinai/PhoWhisper-large';
const STT_ACTIONS = new Set(['stt', 'transcribe', 'asr']);

function voiceCloneRuntime(sampleUrl) {
  const g = publicGatewayUrls({ modelId: 'vieneu-tts-v3-turbo' });
  return {
    publicEndpoint: g.publicEndpoint,
    serverlessEndpoint: g.serverlessEndpoint,
    tokenizeEndpoint: g.tokenizeEndpoint,
    gatewayUrl: g.gatewayUrl,
    env: withUpstreamEnv([{ key: 'VOICE_SAMPLE_URL', value: String(sampleUrl || '') }], {
      runsync: '',
      run: '',
      gateway: '',
      endpointId: '',
      provider: 'runpod_serverless',
    }),
    skills: ['tts', 'stt', 'voice-clone'],
    baseModel: VOICE_CLONE_MODEL,
    systemPrompt: '',
    temperature: 0.8,
    maxTokens: 1024,
  };
}

function voicePresetRuntime(presetName) {
  const g = publicGatewayUrls({ modelId: 'vieneu-tts-v3-turbo' });
  return {
    publicEndpoint: g.publicEndpoint,
    serverlessEndpoint: g.serverlessEndpoint,
    tokenizeEndpoint: g.tokenizeEndpoint,
    gatewayUrl: g.gatewayUrl,
    env: withUpstreamEnv([{ key: 'VIENEU_DEFAULT_VOICE', value: String(presetName || 'Binh') }], {
      runsync: '',
      run: '',
      gateway: '',
      endpointId: '',
      provider: 'runpod_serverless',
    }),
    skills: ['tts', 'stt', 'voice-preset'],
    baseModel: VOICE_CLONE_MODEL,
    systemPrompt: '',
    temperature: 0.8,
    maxTokens: 1024,
  };
}

function voiceCloneProvider() {
  return {
    provider: 'runpod_serverless',
    endpointId: '',
    model: VOICE_CLONE_MODEL,
  };
}

/**
 * A) Seller uploads an MP3 → VieNeu clone via ref_audio on each TTS call.
 */
function applyVoiceCloneToProduct(product) {
  if (!isVoiceCloneCategory(product?.category)) return product;
  const prev = product.contentMeta?.toObject?.() || product.contentMeta || {};
  const sample = String(prev.voiceSampleUrl || '').trim();
  const next = { ...prev, voiceSource: 'clone' };
  if (!sample) {
    next.cloneStatus = 'pending';
    next.cloneError = 'Upload an MP3 of the seller voice first.';
    next.cloneProvider = 'runpod_serverless';
    next.cloneEndpoint = VOICE_CLONE_MODEL;
    product.contentMeta = normalizeContentMeta(product.category, next);
    return product;
  }
  product.runtime = voiceCloneRuntime(sample);
  product.infraProvider = 'runpod_serverless';
  product.provider = 'runpod_serverless';
  next.cloneStatus = 'ready';
  next.cloneProvider = 'runpod_serverless';
  next.cloneEndpoint = VOICE_CLONE_MODEL;
  next.cloneError = '';
  next.cloneReadyAt = new Date().toISOString();
  product.contentMeta = normalizeContentMeta(product.category, next);
  return product;
}

/**
 * B) Platform preset voice — no MP3; TTS uses VieNeu voice= name.
 */
function applyVoicePresetToProduct(product) {
  if (!isVoicePresetCategory(product?.category)) return product;
  const prev = product.contentMeta?.toObject?.() || product.contentMeta || {};
  const hit =
    findPresetVoice(prev.presetVoiceId) ||
    findPresetVoice(prev.presetVoiceName) ||
    findPresetVoice(product?.slug?.replace(/^voice-/, ''));
  const next = {
    ...prev,
    voiceSource: 'preset',
    presetVoiceId: hit?.id || String(prev.presetVoiceId || '').trim(),
    presetVoiceName: hit?.name || String(prev.presetVoiceName || '').trim() || 'Binh',
    cloneStatus: 'ready',
    cloneProvider: prev.cloneProvider || 'runpod_serverless',
    cloneEndpoint: prev.cloneEndpoint || VOICE_CLONE_MODEL,
    cloneError: '',
    cloneReadyAt: prev.cloneReadyAt || new Date().toISOString(),
  };
  product.runtime = voicePresetRuntime(next.presetVoiceName);
  product.infraProvider = 'runpod_serverless';
  product.provider = 'runpod_serverless';
  product.ownershipType = product.ownershipType || 'PLATFORM_DIRECT';
  product.contentMeta = normalizeContentMeta(product.category, next);
  return product;
}

function applyVoiceProduct(product) {
  if (isVoiceCloneCategory(product?.category)) return applyVoiceCloneToProduct(product);
  if (isVoicePresetCategory(product?.category)) return applyVoicePresetToProduct(product);
  return product;
}

/**
 * Buyer STT (PhoWhisper-large) vs TTS (VieNeu clone/preset).
 * STT does not use the seller MP3 — that file is only the clone reference.
 */
function isVoiceSttRequest(input = {}) {
  const action = String(input.action || input.mode || '').toLowerCase();
  if (STT_ACTIONS.has(action)) return true;
  if (input.voice_mode === 'stt' || input.stt === true) return true;
  const hasSpeech = Boolean(input.audio_base64 || input.audio || input.stt_audio_url || input.speech_url);
  const hasText = Boolean(String(input.prompt || input.text || '').trim());
  return hasSpeech && !hasText && input.tts !== true;
}

function voiceSttInput(product, input = {}) {
  const { id: _dropId, idempotencyKey: _dropKey, ...rest } =
    input && typeof input === 'object' ? input : {};
  const sample = String(product?.contentMeta?.voiceSampleUrl || '').trim();
  const buyerUrl = String(rest.stt_audio_url || rest.speech_url || '').trim();
  let audioUrl = String(rest.audio_url || '').trim();
  if (audioUrl && sample && audioUrl === sample) audioUrl = '';
  const lang = String(rest.language || rest.lang || 'vi').trim() || 'vi';
  return {
    ...rest,
    action: 'stt',
    prompt: '',
    text: '',
    voice: '',
    speaker: '',
    audio_base64: rest.audio_base64 || rest.audio || '',
    audio_url: buyerUrl || audioUrl,
    stt_audio_url: buyerUrl || audioUrl,
    language: lang,
    lang,
    tts: false,
    format: rest.format || 'text',
    voice_mode: 'stt',
    stt_model: STT_MODEL,
  };
}

function voiceInferInput(product, input = {}) {
  if (isVoiceSttRequest(input)) return voiceSttInput(product, input);
  return voiceTtsInput(product, input);
}

function voiceTtsInput(product, input = {}) {
  const prompt = String(input.prompt || input.text || '').trim();
  const { id: _dropId, idempotencyKey: _dropKey, ...rest } =
    input && typeof input === 'object' ? input : {};
  const meta = product?.contentMeta || {};
  const presetName = String(meta.presetVoiceId || meta.presetVoiceName || rest.voice || rest.speaker || '').trim();
  const sample = String(meta.voiceSampleUrl || '').trim();

  if (isVoicePresetCategory(product?.category) || meta.voiceSource === 'preset') {
    return {
      ...rest,
      action: rest.action || 'tts',
      prompt,
      text: prompt,
      voice: presetName || 'Binh',
      speaker: presetName || 'Binh',
      audio_url: '',
      ref_audio_url: '',
      denoise: rest.denoise !== false,
      tts: true,
      format: rest.format || 'wav',
      voice_mode: 'preset',
    };
  }

  return {
    ...rest,
    action: rest.action || 'voice_clone',
    prompt,
    text: prompt,
    voice: '',
    audio_url: sample || rest.audio_url || '',
    ref_audio_url: sample || rest.ref_audio_url || rest.audio_url || '',
    denoise: rest.denoise !== false,
    tts: true,
    format: rest.format || 'wav',
    voice_mode: 'clone',
  };
}

module.exports = {
  VOICE_CLONE_MODEL,
  STT_MODEL,
  voiceCloneRuntime,
  voicePresetRuntime,
  voiceCloneProvider,
  applyVoiceCloneToProduct,
  applyVoicePresetToProduct,
  applyVoiceProduct,
  isVoiceSttRequest,
  voiceSttInput,
  voiceInferInput,
  voiceTtsInput,
  isVoiceCategory,
};

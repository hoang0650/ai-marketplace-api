const { publicGatewayUrls, withUpstreamEnv } = require('./gateway-urls');
const { isVoiceCategory, normalizeContentMeta } = require('./license-keys');

const VOICE_CLONE_MODEL = 'pnnbao-ump/VieNeu-TTS-v3-Turbo';

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
    skills: ['tts', 'voice-clone'],
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
 * Seller uploads an MP3 of their voice. TTS/clone runs on the Denglish worker
 * (VieNeu-TTS-v3-Turbo) via RUNPOD_ENDPOINT_ID.
 */
function applyVoiceCloneToProduct(product) {
  if (!isVoiceCategory(product?.category)) return product;
  const prev = product.contentMeta?.toObject?.() || product.contentMeta || {};
  const sample = String(prev.voiceSampleUrl || '').trim();
  const next = { ...prev };
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

function voiceTtsInput(product, input = {}) {
  const prompt = String(input.prompt || input.text || '').trim();
  const sample = String(product?.contentMeta?.voiceSampleUrl || '').trim();
  const { id: _dropId, idempotencyKey: _dropKey, ...rest } = input && typeof input === 'object' ? input : {};
  return {
    ...rest,
    action: rest.action || 'tts',
    prompt,
    text: prompt,
    voice: rest.voice || rest.speaker || '',
    audio_url: sample || rest.audio_url || '',
    ref_audio_url: sample || rest.ref_audio_url || rest.audio_url || '',
    denoise: rest.denoise !== false,
    tts: true,
    format: rest.format || 'wav',
  };
}

module.exports = {
  VOICE_CLONE_MODEL,
  voiceCloneRuntime,
  voiceCloneProvider,
  applyVoiceCloneToProduct,
  voiceTtsInput,
};

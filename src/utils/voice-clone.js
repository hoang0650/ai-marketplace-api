const { getRunpodPublicEndpoint } = require('../data/runpod-public-endpoints');
const { publicGatewayUrls, withUpstreamEnv } = require('./gateway-urls');
const { isVoiceCategory, normalizeContentMeta } = require('./license-keys');

const VOICE_CLONE_ENDPOINT = 'chatterbox-turbo';

function voiceCloneRuntime(sampleUrl) {
  const ep = getRunpodPublicEndpoint(VOICE_CLONE_ENDPOINT) || {};
  const g = publicGatewayUrls({ modelId: VOICE_CLONE_ENDPOINT });
  return {
    publicEndpoint: g.publicEndpoint,
    serverlessEndpoint: g.serverlessEndpoint,
    tokenizeEndpoint: g.tokenizeEndpoint,
    gatewayUrl: g.gatewayUrl,
    env: withUpstreamEnv([{ key: 'VOICE_SAMPLE_URL', value: String(sampleUrl || '') }], {
      runsync: ep.runsyncUrl || `https://api.runpod.ai/v2/${VOICE_CLONE_ENDPOINT}/runsync`,
      run: ep.runUrl || `https://api.runpod.ai/v2/${VOICE_CLONE_ENDPOINT}/run`,
      gateway: '',
      endpointId: VOICE_CLONE_ENDPOINT,
      provider: 'runpod_public',
    }),
    skills: ['tts', 'voice-clone'],
    baseModel: VOICE_CLONE_ENDPOINT,
    systemPrompt: '',
    temperature: 0.7,
    maxTokens: 1024,
  };
}

function voiceCloneProvider() {
  return {
    provider: 'runpod_public',
    endpointId: VOICE_CLONE_ENDPOINT,
    model: VOICE_CLONE_ENDPOINT,
  };
}

/**
 * Seller uploads an MP3 of their voice. We store it as the reference sample and
 * point the listing at Chatterbox (zero-shot clone at TTS time).
 */
function applyVoiceCloneToProduct(product) {
  if (!isVoiceCategory(product?.category)) return product;
  const prev = product.contentMeta?.toObject?.() || product.contentMeta || {};
  const sample = String(prev.voiceSampleUrl || '').trim();
  const next = { ...prev };
  if (!sample) {
    next.cloneStatus = 'pending';
    next.cloneError = 'Upload an MP3 of the seller voice first.';
    next.cloneProvider = 'runpod_public';
    next.cloneEndpoint = VOICE_CLONE_ENDPOINT;
    product.contentMeta = normalizeContentMeta(product.category, next);
    return product;
  }
  product.runtime = voiceCloneRuntime(sample);
  product.infraProvider = 'runpod_public';
  product.provider = 'runpod_public';
  next.cloneStatus = 'ready';
  next.cloneProvider = 'runpod_public';
  next.cloneEndpoint = VOICE_CLONE_ENDPOINT;
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
    prompt,
    audio_url: sample,
    format: rest.format || 'wav',
  };
}

module.exports = {
  VOICE_CLONE_ENDPOINT,
  voiceCloneRuntime,
  voiceCloneProvider,
  applyVoiceCloneToProduct,
  voiceTtsInput,
};

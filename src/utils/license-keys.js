const crypto = require('crypto');

/**
 * Voice listings (both) sell TTS/STT with character usage + day/month/year AIM-xxxx:
 * A) voice-preset — AI Markets platform sells VieNeu presets (PLATFORM_DIRECT)
 * B) voice-clone — seller uploads .mp3 → VieNeu clones that voice (THIRD_PARTY_SELLER)
 * STT for both uses vinai/PhoWhisper-large on the Denglish worker.
 */
const LICENSE_CATEGORIES = new Set([
  'ai-film-series',
  'story-book',
  'skill-pack',
  'dataset',
  'voice-preset',
  'voice-clone',
]);
const VOICE_CATEGORIES = new Set(['voice-clone', 'voice-preset']);
const VOICE_CLONE_CATEGORIES = new Set(['voice-clone']);
const VOICE_PRESET_CATEGORIES = new Set(['voice-preset']);
const WATCH_CONTENT_CATEGORIES = new Set(['ai-film-series', 'story-book']);
const LICENSE_TERMS = ['day', 'month', 'year'];

function isLicenseCategory(category) {
  return LICENSE_CATEGORIES.has(String(category || ''));
}

function isVoiceCategory(category) {
  return VOICE_CATEGORIES.has(String(category || ''));
}

function isVoiceCloneCategory(category) {
  return VOICE_CLONE_CATEGORIES.has(String(category || ''));
}

function isVoicePresetCategory(category) {
  return VOICE_PRESET_CATEGORIES.has(String(category || ''));
}

function isWatchContentCategory(category) {
  return WATCH_CONTENT_CATEGORIES.has(String(category || ''));
}

function normalizeLicenseTerm(raw, fallback = 'month') {
  const t = String(raw || fallback).toLowerCase();
  return LICENSE_TERMS.includes(t) ? t : fallback;
}

function generateLicenseKey() {
  const raw = crypto.randomBytes(8).toString('hex').toUpperCase();
  return `AIM-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

function expiresAtFrom(start, term) {
  const d = new Date(start);
  if (term === 'day') d.setUTCDate(d.getUTCDate() + 1);
  else if (term === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

function resolveLicensePrice(product, requestedTerm) {
  const meta = product?.contentMeta || {};
  const term = normalizeLicenseTerm(
    requestedTerm || meta.licenseTerm || product?.pricing?.interval,
    'month',
  );
  const prices = meta.licensePrices || {};
  const fromMap = Number(prices[term]);
  const unitPrice = fromMap > 0 ? fromMap : Number(product?.pricing?.price) || 0;
  return { term, unitPrice };
}

function effectiveLicenseStatus(doc, now = new Date()) {
  if (!doc) return 'expired';
  if (doc.status === 'revoked') return 'revoked';
  if (new Date(doc.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/** One listing = one license. Same shop / seller never shares a key across products. */
function licenseCoversProduct(doc, productId) {
  if (!doc || !productId) return false;
  return String(doc.product?._id || doc.product) === String(productId);
}

function normalizeVoiceLicensePrices(src) {
  const licensePrices = {};
  for (const t of LICENSE_TERMS) {
    const n = Number(src.licensePrices?.[t]);
    if (n > 0) licensePrices[t] = n;
  }
  return licensePrices;
}

function normalizeContentMeta(category, raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  if (isVoiceCloneCategory(category)) {
    const modes = Array.isArray(src.voiceModes)
      ? src.voiceModes.filter((m) => m === 'tts' || m === 'stt')
      : [];
    return {
      kind: 'voice',
      voiceSource: 'clone',
      voiceModes: modes.length ? modes : ['tts', 'stt'],
      voiceSampleUrl: String(src.voiceSampleUrl || '').slice(0, 500),
      presetVoiceId: '',
      presetVoiceName: '',
      creditUnit: src.creditUnit === 'word' ? 'word' : 'character',
      charactersPerCredit: Math.max(1, Number(src.charactersPerCredit) || 1000),
      cloneStatus: ['pending', 'ready', 'failed'].includes(src.cloneStatus)
        ? src.cloneStatus
        : src.voiceSampleUrl
          ? 'ready'
          : 'pending',
      cloneProvider: String(src.cloneProvider || 'runpod_serverless').slice(0, 64),
      cloneEndpoint: String(src.cloneEndpoint || 'pnnbao-ump/VieNeu-TTS-v3-Turbo').slice(0, 128),
      cloneError: String(src.cloneError || '').slice(0, 500),
      cloneReadyAt: String(src.cloneReadyAt || '').slice(0, 40),
      licenseTerm: normalizeLicenseTerm(src.licenseTerm, 'month'),
      licensePrices: normalizeVoiceLicensePrices(src),
      episodeCount: 0,
    };
  }
  if (isVoicePresetCategory(category)) {
    const modes = Array.isArray(src.voiceModes)
      ? src.voiceModes.filter((m) => m === 'tts' || m === 'stt')
      : [];
    const term = normalizeLicenseTerm(src.licenseTerm, 'month');
    const licensePrices = normalizeVoiceLicensePrices(src);
    return {
      kind: 'voice',
      voiceSource: 'preset',
      voiceModes: modes.length ? modes : ['tts', 'stt'],
      voiceSampleUrl: '',
      presetVoiceId: String(src.presetVoiceId || '').slice(0, 64),
      presetVoiceName: String(src.presetVoiceName || '').slice(0, 120),
      creditUnit: src.creditUnit === 'word' ? 'word' : 'character',
      charactersPerCredit: Math.max(1, Number(src.charactersPerCredit) || 1000),
      cloneStatus: 'ready',
      cloneProvider: 'runpod_serverless',
      cloneEndpoint: 'pnnbao-ump/VieNeu-TTS-v3-Turbo',
      cloneError: '',
      cloneReadyAt: String(src.cloneReadyAt || new Date().toISOString()).slice(0, 40),
      licenseTerm: term,
      licensePrices,
      episodeCount: 0,
    };
  }
  if (isLicenseCategory(category)) {
    const term = normalizeLicenseTerm(src.licenseTerm, 'month');
    const licensePrices = normalizeVoiceLicensePrices(src);
    return {
      kind:
        category === 'story-book'
          ? 'story'
          : category === 'skill-pack'
            ? 'skill'
            : category === 'dataset'
              ? 'dataset'
              : 'series',
      episodeCount:
        category === 'ai-film-series' || category === 'story-book'
          ? Math.max(0, Number(src.episodeCount) || 0)
          : 0,
      licenseTerm: term,
      licensePrices,
    };
  }
  return null;
}

module.exports = {
  LICENSE_CATEGORIES,
  VOICE_CATEGORIES,
  VOICE_CLONE_CATEGORIES,
  VOICE_PRESET_CATEGORIES,
  WATCH_CONTENT_CATEGORIES,
  LICENSE_TERMS,
  isLicenseCategory,
  isVoiceCategory,
  isVoiceCloneCategory,
  isVoicePresetCategory,
  isWatchContentCategory,
  normalizeLicenseTerm,
  generateLicenseKey,
  expiresAtFrom,
  resolveLicensePrice,
  effectiveLicenseStatus,
  licenseCoversProduct,
  normalizeContentMeta,
};

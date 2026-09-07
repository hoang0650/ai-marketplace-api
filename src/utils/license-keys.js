const crypto = require('crypto');

const LICENSE_CATEGORIES = new Set(['ai-film-series', 'story-book', 'skill-pack', 'dataset']);
const VOICE_CATEGORIES = new Set(['voice-clone']);
const LICENSE_TERMS = ['day', 'month', 'year'];

function isLicenseCategory(category) {
  return LICENSE_CATEGORIES.has(String(category || ''));
}

function isVoiceCategory(category) {
  return VOICE_CATEGORIES.has(String(category || ''));
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

function normalizeContentMeta(category, raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  if (isVoiceCategory(category)) {
    const modes = Array.isArray(src.voiceModes)
      ? src.voiceModes.filter((m) => m === 'tts' || m === 'stt')
      : [];
    return {
      kind: 'voice',
      voiceModes: modes.length ? modes : ['tts'],
      voiceSampleUrl: String(src.voiceSampleUrl || '').slice(0, 500),
      creditUnit: src.creditUnit === 'word' ? 'word' : 'character',
      charactersPerCredit: Math.max(1, Number(src.charactersPerCredit) || 1000),
    };
  }
  if (isLicenseCategory(category)) {
    const term = normalizeLicenseTerm(src.licenseTerm, 'month');
    const licensePrices = {};
    for (const t of LICENSE_TERMS) {
      const n = Number(src.licensePrices?.[t]);
      if (n > 0) licensePrices[t] = n;
    }
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
  LICENSE_TERMS,
  isLicenseCategory,
  isVoiceCategory,
  normalizeLicenseTerm,
  generateLicenseKey,
  expiresAtFrom,
  resolveLicensePrice,
  effectiveLicenseStatus,
  normalizeContentMeta,
};

const { isVoiceCategory } = require('./license-keys');

const DEFAULT_VOICE_MP3 = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3';
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();

function pruneCache(now = Date.now()) {
  for (const [id, row] of cache) {
    if (!row || row.expires <= now) cache.delete(id);
  }
}

function putVoiceAudio(id, buffer, contentType = 'audio/mpeg') {
  pruneCache();
  cache.set(String(id), {
    buffer,
    contentType: contentType || 'audio/mpeg',
    expires: Date.now() + CACHE_TTL_MS,
  });
}

function getVoiceAudio(id) {
  pruneCache();
  const row = cache.get(String(id));
  if (!row) return null;
  return row;
}

function voiceSampleUrl(product) {
  const url = String(product?.contentMeta?.voiceSampleUrl || '').trim();
  return url || DEFAULT_VOICE_MP3;
}

function hasVoiceSample(product) {
  return Boolean(String(product?.contentMeta?.voiceSampleUrl || '').trim());
}

function voiceLang(product) {
  const tags = (product?.tags || []).map((t) => String(t).toLowerCase());
  if (tags.includes('english') || /(?:^|-)en(?:-|$)/i.test(String(product?.slug || ''))) return 'en';
  return 'vi';
}

function publicApiOrigin(req) {
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = xfProto || req.protocol || 'https';
  const host = req.get('host') || 'api.aimarkets.vn';
  return `${proto}://${host}`;
}

function voiceAudioPublicUrl(req, id) {
  return `${publicApiOrigin(req)}/v1/playground/audio/${encodeURIComponent(String(id))}.mp3`;
}

function voiceSamplePublicUrl(req, slug) {
  return `${publicApiOrigin(req)}/v1/playground/voice/${encodeURIComponent(String(slug))}.mp3`;
}

async function fetchMp3Buffer(url) {
  const { fetchSafeHttp } = require('./safe-http-url');
  const { buffer, res } = await fetchSafeHttp(url, {
    timeoutMs: 20000,
    maxBytes: 12 * 1024 * 1024,
    headers: { 'User-Agent': 'AI-Markets-Voice/1.0' },
  });
  if (buffer.length < 64) {
    const err = new Error('audio too small');
    err.status = 502;
    throw err;
  }
  const type = String(res.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim();
  return { buffer, contentType: type.includes('audio') ? type : 'audio/mpeg' };
}

/** Stream the seller's uploaded voice sample (not generic TTS). */
async function resolveVoiceMp3({ product }) {
  return fetchMp3Buffer(voiceSampleUrl(product));
}

function sendMp3(res, { buffer, contentType }) {
  res.setHeader('Content-Type', contentType || 'audio/mpeg');
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Content-Disposition', 'inline; filename="voice.mp3"');
  res.send(buffer);
}

function isVoiceProduct(product) {
  return isVoiceCategory(product?.category);
}

module.exports = {
  DEFAULT_VOICE_MP3,
  putVoiceAudio,
  getVoiceAudio,
  voiceSampleUrl,
  hasVoiceSample,
  voiceLang,
  voiceAudioPublicUrl,
  voiceSamplePublicUrl,
  fetchMp3Buffer,
  resolveVoiceMp3,
  sendMp3,
  isVoiceProduct,
};

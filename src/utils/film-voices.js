const Product = require('../models/Product');
const LicenseKey = require('../models/LicenseKey');
const drm = require('./content-drm');
const audio = require('./voice-audio');
const filmLangs = require('./film-langs');
const minio = require('../config/minio');

function error(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function usable(product) {
  return product && product.published === true && product.category === 'voice-clone' &&
    product.contentMeta?.cloneStatus === 'ready' && !!product.contentMeta.voiceSampleUrl &&
    (!product.contentMeta.voiceModes?.length || product.contentMeta.voiceModes.includes('tts')) &&
    (!product.moderationStatus || product.moderationStatus === 'active') &&
    (!product.suspendedUntil || new Date(product.suspendedUntil) <= new Date());
}
async function catalog(user) {
  const products = await Product.find({ category: 'voice-clone', published: true, 'contentMeta.cloneStatus': 'ready' })
    .select('name slug creator creatorName category published moderationStatus suspendedUntil contentMeta').sort({ updatedAt: -1 }).limit(100).lean();
  const now = new Date();
  const licenses = await LicenseKey.find({ buyer: user._id, product: { $in: products.map(p => p._id) }, status: 'active', startsAt: { $lte: now }, expiresAt: { $gt: now } }).select('product').lean();
  const owned = new Set(licenses.map(l => String(l.product)));
  return products.filter(usable).map(p => ({ id: String(p._id), name: p.name, slug: p.slug, seller: p.creatorName || '', languages: p.contentMeta.voiceLanguages || [], available: owned.has(String(p._id)) || String(p.creator) === String(user._id) }));
}
async function narration(project, scene, user, refs) {
  if (!scene.narration) return null;
  const base = { text: scene.narration, ...filmLangs.sceneVoice(project, scene) };
  const source = scene.voiceSource || 'preset';
  if (source === 'preset') return base;
  let refId, url;
  if (source === 'upload') {
    const upload = project.uploads.find(u => u.uid === scene.voiceUploadId && u.kind === 'audio' && u.status === 'ready');
    if (!upload || !Number.isFinite(upload.duration) || upload.duration < 6 || upload.duration > 15 || !(upload.size > 0) || upload.size > 12 * 1024 ** 2) throw error('VOICE_SAMPLE_INVALID', 'Giọng mẫu cần là file âm thanh 6–15 giây, tối đa 12 MB.');
    refId = 'upload_' + upload.uid;
    url = await minio.presignFilmGet(upload.key, 6 * 3600);
  } else {
    const product = /^[a-f0-9]{24}$/i.test(String(scene.voiceProductId || '')) ? await Product.findById(scene.voiceProductId).lean() : null;
    if (!usable(product)) throw error('VOICE_UNAVAILABLE', 'Giọng clone chưa sẵn sàng hoặc đã ngừng bán.');
    const served = product.contentMeta.voiceLanguages || [];
    if (served.length && !served.includes(base.lang)) throw error('VOICE_LANGUAGE_UNSUPPORTED', 'Giọng clone không hỗ trợ ngôn ngữ của cảnh này.');
    if (String(product.creator) !== String(user._id) && !await drm.findActiveLicense({ buyerId: user._id, productId: product._id })) throw error('VOICE_LICENSE_REQUIRED', 'Cần mua hoặc gia hạn license của giọng clone trước khi dùng.', 402);
    refId = 'product_' + product._id;
    url = product.contentMeta.voiceSampleUrl;
  }
  if (!refs[refId]) {
    const { buffer } = await audio.fetchMp3Buffer(url);
    const size = Object.values(refs).reduce((s, b) => s + Buffer.byteLength(b, 'base64'), 0) + buffer.length;
    if (size > 12 * 1024 ** 2) throw error('VOICE_SAMPLES_TOO_LARGE', 'Tổng giọng mẫu của phim vượt 12 MB. Hãy dùng các file mẫu ngắn hơn.', 413);
    refs[refId] = buffer.toString('base64');
  }
  return { ...base, voiceReference: refId };
}
module.exports = { catalog, narration, usable };

const Product = require('../models/Product');
const { resolveProviderForProduct } = require('./provider-resolve');
const { gpuFetch } = require('./aimx-gpu');
const fp = require('./film-pricing');
const DEFAULT_VIDEO = 'wan-2-2-i2v-720';
const DEFAULT_IMAGE = 'qwen-image-edit-2511';
let cache = { at: 0, items: [] };
async function catalog() {
  if (Date.now() - cache.at < 30000) return cache.items;
  const response = await gpuFetch('/film/models', { timeout: 15000 });
  if (!response.ok) throw Object.assign(new Error('Film model catalog unavailable'), { status: 503 });
  const data = await response.json();
  const products = await Product.find({ published: true, moderationStatus: 'active', ownershipType: 'PLATFORM_DIRECT', infraProvider: 'runpod' })
    .select('slug name category tags runtime pricing').lean();
  const byEndpoint = new Map(products.map(p => [resolveProviderForProduct(p).endpointId, p]));
  const items = (data.items || []).filter(m => byEndpoint.has(m.id)).map(m => {
    const p = byEndpoint.get(m.id);
    return { ...m, productId: String(p._id), productSlug: p.slug, name: p.name, marketplacePricing: p.pricing };
  });
  cache = { at: Date.now(), items };
  return items;
}
function model(id, kind) {
  const key = id || (kind === 'video' ? DEFAULT_VIDEO : DEFAULT_IMAGE);
  const found = cache.items.find(m => (m.id === key || m.slug === key) && m.kind === kind && m.available);
  if (!found) throw Object.assign(new Error('Model unavailable for this film input'), { status: 400, code: 'BAD_INPUT' });
  return found;
}
function splitDuration(total, id) {
  if (!id || id === DEFAULT_VIDEO) return fp.splitDuration(total);
  const options = [...model(id, 'video').durations].sort((a, b) => b - a);
  const target = Math.max(5, Math.min(60, Math.round(Number(total) || 5)));
  const dp = Array(61).fill(null); dp[0] = [];
  for (let n = 1; n <= 60; n++) for (const d of options) {
    if (n >= d && dp[n - d] && dp[n - d].length < 12) {
      const candidate = [...dp[n - d], d];
      if (!dp[n] || candidate.length < dp[n].length) dp[n] = candidate;
    }
  }
  const hits = dp.map((shots, seconds) => ({ shots, seconds })).filter(x => x.seconds && x.shots);
  hits.sort((a, b) => Math.abs(a.seconds - target) - Math.abs(b.seconds - target) || (a.seconds > target) - (b.seconds > target) || a.shots.length - b.shots.length);
  if (!hits.length) throw Object.assign(new Error('No supported duration'), { status: 400 });
  return hits[0].shots.sort((a, b) => b - a);
}
async function quote({ videoModel, imageModel, shots = [], images = 0, mode = 'keyframe' }) {
  await catalog();
  if (shots.length) videoModel = model(videoModel, 'video').id;
  if (images) imageModel = model(imageModel, 'image').id;
  const r = await gpuFetch('/film/quote', { method: 'POST', body: JSON.stringify({ videoModel, imageModel, shots, images, mode }), timeout: 15000 });
  if (!r.ok) throw Object.assign(new Error('Model quote unavailable'), { status: r.status === 400 ? 400 : 503 });
  const q = await r.json();
  if (!Number.isFinite(q.price) || q.price < 0) throw new Error('Invalid model quote');
  return { ...q, videoModel, imageModel, rates: { perSecond: shots.length ? q.shots.reduce((a, s) => a + s.price, 0) / shots.reduce((a, d) => a + d, 0) : 0, perImage: q.imagePrice } };
}
module.exports = { catalog, model, splitDuration, quote, DEFAULT_VIDEO, DEFAULT_IMAGE };

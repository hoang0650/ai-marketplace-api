const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Product = require('../../src/models/Product');
const aimx = require('../../src/utils/aimx-gpu');
const originalFind = Product.find, originalFetch = aimx.gpuFetch;
const items = [
  { id: 'wan-2-2-i2v-720', slug: 'wan-2-2-i2v', kind: 'video', modality: 'image-to-video', available: true, durations: [5, 8] },
  { id: 'sora-2-i2v', slug: 'sora-2', kind: 'video', modality: 'image-to-video', available: true, durations: [4, 8, 12] },
  { id: 'qwen-image-edit-2511', slug: 'qwen-image-edit-2511', kind: 'image', available: true },
  { id: 'unpublished-model', slug: 'unpublished-model', kind: 'image', available: true },
];
Product.find = q => {
  assert.equal(q.published, true); assert.equal(q.moderationStatus, 'active');
  return { select: () => ({ lean: async () => items.slice(0, 3).map((m, i) => ({
    _id: String(i), slug: 'aim-' + m.slug, name: m.slug, category: m.modality || 'image-to-image',
    runtime: { env: [{ key: 'AI_PROVIDER', value: 'runpod_public' }, { key: 'PROVIDER_ENDPOINT_ID', value: m.id }] }, pricing: { usageRate: 0.05 },
  })) }) };
};
aimx.gpuFetch = async (path, opts) => {
  if (path === '/film/models') return new Response(JSON.stringify({ items }));
  assert.equal(path, '/film/quote');
  const b = JSON.parse(opts.body);
  assert.equal(b.videoModel, 'sora-2-i2v');
  return new Response(JSON.stringify({ shots: [{ price: 1.056 }, { price: 2.112 }], imagePrice: 0.0528, price: 3.2208 }));
};
const fm = require('../../src/utils/film-models');
after(() => { Product.find = originalFind; aimx.gpuFetch = originalFetch; });
test('film choices include only real published marketplace products', async () => {
  const models = await fm.catalog();
  assert.equal(models.length, 3);
  assert.equal(models[0].productId, '0');
  assert.throws(() => fm.model('unpublished-model', 'image'));
  assert.throws(() => fm.model('sora-2-i2v', 'image'));
});
test('duration planning uses each model constraints and remains within 60 seconds', async () => {
  await fm.catalog();
  assert.deepEqual(fm.splitDuration(20, 'wan-2-2-i2v-720'), [8, 8, 5]);
  assert.deepEqual(fm.splitDuration(20, 'sora-2-i2v'), [12, 8]);
  for (let n = 5; n <= 60; n += 5) {
    const shots = fm.splitDuration(n, 'sora-2-i2v');
    assert.ok(shots.every(d => [4, 8, 12].includes(d)));
    assert.ok(shots.reduce((a, d) => a + d, 0) <= 60);
  }
});
test('film forwards selected models to shared provider quote; no fixed film tariff', async () => {
  const q = await fm.quote({ videoModel: 'sora-2', imageModel: 'qwen-image-edit-2511', shots: [4, 8], images: 1 });
  assert.equal(q.videoModel, 'sora-2-i2v');
  assert.equal(q.price, 3.2208);
  assert.equal(q.rates.perImage, 0.0528);
  assert.equal(q.shots[1].price, 2.112);
});

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const slug = require('../../src/utils/product-slug');
const wl = require('../../src/utils/white-label');
const minio = require('../../src/config/minio');
const media = require('../../src/utils/media-rehost');

const saved = [];
function stub(obj, key, fn) {
  saved.push([obj, key, obj[key]]);
  obj[key] = fn;
}
afterEach(() => {
  while (saved.length) {
    const [obj, key, orig] = saved.pop();
    obj[key] = orig;
  }
});

describe('catalog product slugs', () => {
  test('legacy runpod- slugs resolve to aim-', () => {
    assert.equal(slug.catalogProductSlug('flux-dev'), 'aim-flux-dev');
    assert.equal(slug.canonicalProductSlug(' RunPod-Flux-Dev '), 'aim-flux-dev');
    assert.equal(slug.canonicalProductSlug('my-agent'), 'my-agent');
    assert.equal(slug.catalogModelSlug('aim-flux-dev'), 'flux-dev');
    assert.equal(slug.catalogModelSlug('runpod-flux-dev'), 'flux-dev');
    assert.equal(slug.isCatalogProductSlug('aim-x'), true);
    assert.equal(slug.isCatalogProductSlug('gpu-a100-train'), false);
  });

  test('lookup query keeps the raw slug so seller products are never shadowed', () => {
    assert.deepEqual(slug.productSlugQuery('runpod-flux-dev'), { slug: { $in: ['aim-flux-dev', 'runpod-flux-dev'] } });
    assert.deepEqual(slug.productSlugQuery('My-Bot'), { slug: 'my-bot' });
  });
});

describe('white-label helpers', () => {
  test('registry rows use alias keys and neutral labels', () => {
    const row = wl.publicRegistryRow({ provider: 'runpod', label: 'RunPod', description: 'RunPod Pods on demand' });
    assert.equal(row.provider, 'aimarkets-gpu');
    assert.equal(row.label, 'AI Markets GPU');
    assert.equal(row.description, 'GPU Pods on demand');
    assert.equal(wl.publicRegistryRow({ provider: 'aws', label: 'AWS' }).label, 'AWS');
  });

  test('publicPayload drops the cost basis only', () => {
    const out = wl.publicPayload({ image_url: 'x', cost: 0.2, upstream_cost: 0.1, markup: 0.3, upstreamCost: 1 });
    assert.deepEqual(out, { image_url: 'x', cost: 0.2 });
    assert.deepEqual(wl.publicPayload([1, 2]), [1, 2]);
  });

  test('scrubVendorDeep rewrites nested error bodies', () => {
    const out = wl.scrubVendorDeep({ error: { message: 'RunPod endpoint failed' } });
    assert.equal(out.error.message, 'GPU cloud endpoint failed');
    assert.equal(wl.scrubVendorDeep(null), null);
  });
});

describe('minio settings', () => {
  const KEYS = ['AIMARKETS_MINIO_BUCKET', 'MINIO_BUCKET', 'AIMARKETS_MINIO_ACCESS_KEY', 'MINIO_ACCESS_KEY', 'MINIO_ROOT_USER'];
  const env = {};
  afterEach(() => {
    for (const k of KEYS) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  });
  function setEnv(values) {
    for (const k of KEYS) {
      if (!(k in env)) env[k] = process.env[k];
      delete process.env[k];
    }
    Object.assign(process.env, values);
  }

  test('AIMARKETS_ names win over the shared PHHotel names', () => {
    setEnv({ MINIO_BUCKET: 'phhotel', AIMARKETS_MINIO_BUCKET: 'aimarkets' });
    assert.equal(minio.getMinioConfig().bucket, 'aimarkets');
  });

  test('shared names and root fallbacks still work', () => {
    setEnv({ MINIO_BUCKET: 'phhotel', MINIO_ROOT_USER: 'root' });
    assert.equal(minio.getMinioConfig().bucket, 'phhotel');
    assert.equal(minio.minioEnv('MINIO_ACCESS_KEY', 'MINIO_ROOT_USER'), 'root');
    setEnv({});
    assert.equal(minio.getMinioConfig().bucket, 'phhotel');
  });
});

describe('media rehosting', () => {
  test('only foreign http(s) URLs are rehosted', () => {
    assert.equal(media.isForeignMediaUrl('https://files.example-cdn.net/out.png'), true);
    assert.equal(media.isForeignMediaUrl('https://api.aimarkets.vn/v1/media/abc'), false);
    assert.equal(media.isForeignMediaUrl('https://minio.phhotel.vn/phhotel/a.png'), false);
    assert.equal(media.isForeignMediaUrl('data:image/png;base64,AAAA'), false);
    assert.equal(media.isForeignMediaUrl('a sunset over the sea'), false);
  });

  test('signed links round-trip and reject tampering', () => {
    const token = media.signMediaLink('https://files.example-cdn.net/out.mp4');
    assert.equal(media.verifyMediaLink(token), 'https://files.example-cdn.net/out.mp4');
    assert.equal(media.verifyMediaLink(`${token}x`), null);
    assert.equal(media.verifyMediaLink(''), null);
  });

  test('without MinIO, payload URLs become signed API links and cost basis is removed', async () => {
    stub(minio, 'isMinioEnabled', () => false);
    const src = 'https://files.example-cdn.net/out.png';
    const out = await media.rehostMediaDeep(
      { image_url: src, images: [src], text: 'done', upstream_cost: 0.01, nested: { video_url: 'https://api.aimarkets.vn/x.mp4' } },
      { baseUrl: 'https://api.aimarkets.vn/' }
    );
    assert.match(out.image_url, /^https:\/\/api\.aimarkets\.vn\/v1\/media\/[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.equal(out.images[0], out.image_url);
    assert.equal(media.verifyMediaLink(out.image_url.split('/').pop()), src);
    assert.equal(out.text, 'done');
    assert.equal(out.nested.video_url, 'https://api.aimarkets.vn/x.mp4');
    assert.equal('upstream_cost' in out, false);
  });

  test('payloads without foreign URLs are returned untouched', async () => {
    const input = { text: 'hi' };
    assert.deepEqual(await media.rehostMediaDeep(input, { baseUrl: 'https://api.aimarkets.vn' }), input);
    assert.equal(await media.rehostMediaDeep(null), null);
  });
});

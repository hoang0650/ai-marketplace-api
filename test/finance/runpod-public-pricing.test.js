const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const pricing = require('../../src/utils/runpod-public-pricing');
const { computeUsageCost } = require('../../src/utils/provider-resolve');
const { buildRunpodMarketplaceProducts } = require('../../src/data/runpod-marketplace-products');
const { listRunpodPublicEndpoints, getRunpodPublicEndpoint } = require('../../src/data/runpod-public-endpoints');
const catalog = require('../../src/data/runpod-public-endpoints.json');

const ENV = ['RUNPOD_PUBLIC_MARKUP', 'GPU_RENTAL_MARKUP'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('public endpoint markup', () => {
  test('defaults to the GPU rental markup; RUNPOD_PUBLIC_MARKUP overrides', () => {
    delete process.env.RUNPOD_PUBLIC_MARKUP;
    delete process.env.GPU_RENTAL_MARKUP;
    assert.equal(pricing.runpodPublicMarkup(), 0.32);
    process.env.GPU_RENTAL_MARKUP = '0.4';
    assert.equal(pricing.runpodPublicMarkup(), 0.4);
    process.env.RUNPOD_PUBLIC_MARKUP = '0.5';
    assert.equal(pricing.runpodPublicMarkup(), 0.5);
  });

  test('sell price text marks up every amount', () => {
    delete process.env.RUNPOD_PUBLIC_MARKUP;
    delete process.env.GPU_RENTAL_MARKUP;
    assert.equal(pricing.sellPricingText('$0.02/megapixel'), '$0.0264/megapixel');
    assert.equal(pricing.sellPricingText('$10.00/1M tokens'), '$13.20/1M tokens');
    assert.equal(pricing.sellPricingText('$0.40 (4s), $0.80 (8s)'), '$0.528 (4s), $1.06 (8s)');
  });
});

describe('upstream cost basis billing', () => {
  const product = (over = {}) => ({
    category: 'text-to-image',
    pricing: { model: 'usage', currency: 'USD', usageUnit: 'megapixel', usageRate: 0.026, costBasis: 'upstream', ...over },
  });

  test('charge = provider-reported cost × (1 + markup), regardless of unit', () => {
    delete process.env.RUNPOD_PUBLIC_MARKUP;
    delete process.env.GPU_RENTAL_MARKUP;
    // 512×512 Flux Dev = $0.0052 upstream → $0.006864
    assert.equal(computeUsageCost(product(), { unit: 'images', quantity: 1 }, {}, { upstream: 0.0052, cost: 0.0065 }), 0.006864);
    // video billed per clip: 5s @ $0.25 → $0.33 (never seconds × per-video rate)
    const video = product({ usageUnit: 'video', usageRate: 0.33 });
    assert.equal(computeUsageCost(video, { unit: 'seconds', quantity: 5 }, {}, { upstream: 0.25 }), 0.33);
  });

  test('falls back to a sell estimate, then to the listed price', () => {
    assert.equal(computeUsageCost(product(), { unit: 'images' }, {}, { upstream: 0, cost: 0.004 }), 0.004);
    assert.equal(computeUsageCost(product(), { unit: 'images' }, {}, 0), 0.026);
  });

  test('sandbox and non-upstream products are unchanged', () => {
    assert.equal(computeUsageCost(product(), { sandbox: true }, {}, { upstream: 1 }), 0);
    const seller = { category: 'inference', pricing: { model: 'usage', currency: 'USD', usageUnit: '1M tokens', usageRate: 2 } };
    assert.equal(computeUsageCost(seller, { total_tokens: 500000 }, {}, { upstream: 9 }), 1);
  });
});

describe('catalog products', () => {
  test('every product lists marked-up price in the provider unit and bills by upstream cost', () => {
    delete process.env.RUNPOD_PUBLIC_MARKUP;
    delete process.env.GPU_RENTAL_MARKUP;
    const products = buildRunpodMarketplaceProducts();
    assert.equal(products.length, catalog.length);
    for (const ep of catalog) {
      const p = products.find((x) => x.slug === `aim-${ep.slug}`);
      assert.ok(p, ep.slug);
      assert.equal(p.pricing.costBasis, 'upstream');
      assert.equal(p.pricing.usageUnit, ep.price.unit, ep.slug);
      assert.equal(p.pricing.usageRate, Math.round(ep.price.rate * 1.32 * 1e6) / 1e6, ep.slug);
      assert.ok(!p.tagline.includes(ep.pricing) || !/\$/.test(ep.pricing), `${ep.slug} tagline shows sell price`);
    }
  });

  test('retired/deprecated models are unpublished and hidden from the public catalog', () => {
    const products = buildRunpodMarketplaceProducts();
    for (const slug of ['nano-banana-edit', 'kling-v2-1', 'cogito-671b', 'seedance-1-5-pro']) {
      assert.equal(products.find((p) => p.slug === `aim-${slug}`).published, false, slug);
      assert.ok(!listRunpodPublicEndpoints().some((e) => e.slug === slug), slug);
    }
    assert.ok(products.find((p) => p.slug === 'aim-seedance-2-5-i2v').published);
  });

  test('public catalog never exposes the provider base price', () => {
    delete process.env.RUNPOD_PUBLIC_MARKUP;
    delete process.env.GPU_RENTAL_MARKUP;
    const e = getRunpodPublicEndpoint('flux-dev');
    assert.equal(e.pricing, '$0.0264/megapixel');
    assert.deepEqual(e.price, { rate: 0.0264, unit: 'megapixel', currency: 'USD' });
  });
});

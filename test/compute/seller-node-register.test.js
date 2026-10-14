const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Product = require('../../src/models/Product');
const GpuServer = require('../../src/models/GpuServer');
const { registerComputeNode, sellerNodeConfig } = require('../../src/utils/compute-session');

const owner = () => ({ _id: new mongoose.Types.ObjectId(), role: 'seller' });

function stubProduct(t, user, category = 'game-server') {
  const product = { _id: new mongoose.Types.ObjectId(), slug: 'my-game', name: 'My game', category, creator: user._id, seller: user._id, owner: user._id, creatorSlug: 'me' };
  t.mock.method(Product, 'findOne', async () => product);
  t.mock.method(Product, 'findById', () => ({ lean: async () => product, select: () => ({ lean: async () => product }) }));
  t.mock.method(Product, 'updateOne', async () => ({}));
  t.mock.method(GpuServer, 'find', () => ({ lean: async () => [], select: () => ({ lean: async () => [] }) }));
  return product;
}

test('external node needs a webhook, a stream or an iframe', async (t) => {
  const u = owner();
  stubProduct(t, u);
  const create = t.mock.method(GpuServer, 'create', async (d) => d);
  await assert.rejects(registerComputeNode(u, { productSlug: 'my-game', hosting: 'external' }), (e) => e.code === 'NODE_TARGET_REQUIRED');
  assert.equal(create.mock.callCount(), 0);
});

test('webhook must be https', async (t) => {
  const u = owner();
  stubProduct(t, u);
  await assert.rejects(registerComputeNode(u, { productSlug: 'my-game', webhookUrl: 'http://seller.example.com/hook' }));
});

test('short webhook secrets are refused', async (t) => {
  const u = owner();
  stubProduct(t, u);
  await assert.rejects(
    registerComputeNode(u, { productSlug: 'my-game', iframeUrl: 'https://example.com/play', webhookSecret: 'short' }),
    (e) => e.code === 'WEBHOOK_SECRET_TOO_SHORT',
  );
});

test('non-compute products are refused', async (t) => {
  const u = owner();
  stubProduct(t, u, 'template-web');
  await assert.rejects(registerComputeNode(u, { productSlug: 'my-game', iframeUrl: 'https://example.com/play' }), (e) => e.code === 'NOT_COMPUTE_PRODUCT');
});

test('seller config never contains the webhook secret', () => {
  const cfg = sellerNodeConfig({ webhookUrl: 'https://x.example/h', webhookSecret: 'whsec_supersecretvalue123' });
  assert.equal(cfg.hasWebhookSecret, true);
  assert.equal(JSON.stringify(cfg).includes('supersecret'), false);
});

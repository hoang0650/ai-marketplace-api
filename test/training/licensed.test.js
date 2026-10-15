const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const LicenseKey = require('../../src/models/LicenseKey');
const Product = require('../../src/models/Product');
const ContentEpisode = require('../../src/models/ContentEpisode');
const TrainingDataset = require('../../src/models/TrainingDataset');
const LicenseKeyModel = LicenseKey;
const router = require('../../src/routes/training-datasets');

const U = new mongoose.Types.ObjectId();
const DS = new mongoose.Types.ObjectId();
const VOICE = new mongoose.Types.ObjectId();
const EXPIRED = new mongoose.Types.ObjectId();

function route(method, path) {
  const l = router.stack.find((x) => x.route && x.route.path === path && x.route.methods[method]);
  return l.route.stack.at(-1).handle;
}
function call(handler, { params = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = { user: { _id: U }, params, query: {}, body: {}, get: () => '' };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}
const q = (v) => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => v });
const future = new Date(Date.now() + 864e5);

test('licensed: lists active dataset + voice licenses of the caller only, with file counts', async (t) => {
  t.mock.method(LicenseKey, 'find', (filter) => {
    assert.equal(String(filter.buyer), String(U), 'scoped to the caller');
    return q([
      { product: DS, category: 'dataset', status: 'active', term: 'month', expiresAt: future },
      { product: VOICE, category: 'voice-preset', status: 'active', term: 'day', expiresAt: future },
      { product: EXPIRED, category: 'dataset', status: 'active', term: 'day', expiresAt: new Date(Date.now() - 1000) },
    ]);
  });
  t.mock.method(Product, 'find', (f) => {
    assert.ok(!f._id.$in.some((x) => String(x) === String(EXPIRED)), 'expired license excluded');
    return q([
      { _id: DS, name: 'Hotel Ops', slug: 'hotel', category: 'dataset' },
      { _id: VOICE, name: 'Mai', slug: 'mai', category: 'voice-preset', contentMeta: { voiceModes: ['tts'] } },
    ]);
  });
  t.mock.method(ContentEpisode, 'find', () => q([{ product: DS, size: 10, kind: 'text' }, { product: DS, size: 5, kind: 'text' }]));
  t.mock.method(TrainingDataset, 'find', () => q([]));
  const r = await call(route('get', '/licensed'));
  assert.equal(r.body.datasets.length, 1);
  assert.equal(r.body.datasets[0].fileCount, 2);
  assert.equal(r.body.datasets[0].totalBytes, 15);
  assert.equal(r.body.voices.length, 1);
  assert.equal(r.body.voices[0].voiceSource, 'preset');
});

test('licensed import: requires an active license; empty listing is a clear error', async (t) => {
  t.mock.method(Product, 'findById', () => q({ _id: DS, name: 'Hotel Ops', category: 'dataset' }));
  t.mock.method(LicenseKeyModel, 'find', () => ({ sort() { return this; }, limit: async () => [] }));
  t.mock.method(LicenseKeyModel, 'findOne', async () => null);
  const r = await call(route('post', '/licensed/:productId/import'), { params: { productId: String(DS) } });
  assert.equal(r.status, 402);
  assert.equal(r.body.code, 'LICENSE_REQUIRED');
});

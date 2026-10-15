const test = require('node:test');
const assert = require('node:assert/strict');
const Product = require('../../src/models/Product');
const BuilderTemplate = require('../../src/models/BuilderTemplate');
const router = require('../../src/routes/builder-templates');

const layer = router.stack.find((l) => l.route && String(l.route.path).includes('demo-qr'));

function call(id) {
  return new Promise((resolve, reject) => {
    const req = { params: { 0: id }, url: `/${id}/demo-qr.svg` };
    const res = {
      statusCode: 200,
      headers: {},
      status(c) { this.statusCode = c; return this; },
      set(h) { Object.assign(this.headers, h); return this; },
      type() { return this; },
      send(b) { resolve({ status: this.statusCode, headers: this.headers, body: String(b) }); return this; },
    };
    layer.route.stack.at(-1).handle(req, res, reject);
  });
}

const ID = '6ac0712083e72c0f6a09f024';
const lean = (v) => ({ select() { return this; }, lean: async () => v });

test('demo QR is an SVG pointing at the web simulator page', async (t) => {
  t.mock.method(Product, 'findById', () => lean({ _id: ID, name: 'x', category: 'template-app', moderationStatus: 'active', published: true }));
  // Real query: the files must be selected, otherwise demoVisible() is always false.
  t.mock.method(BuilderTemplate, 'findOne', () => ({
    select(fields) {
      assert.match(fields, /files/);
      return { lean: async () => ({ demoEnabled: true, kind: 'app', files: [{ path: 'App.js' }] }) };
    },
  }));
  const r = await call(ID);
  assert.equal(r.status, 200);
  assert.match(r.headers['Content-Type'], /image\/svg\+xml/);
  assert.match(r.body, /^<svg/);
});

test('demo QR 404s when the demo is hidden', async (t) => {
  t.mock.method(Product, 'findById', () => lean({ _id: ID, category: 'template-app', moderationStatus: 'active' }));
  t.mock.method(BuilderTemplate, 'findOne', () => lean({ demoEnabled: false, files: [{ path: 'App.js' }] }));
  assert.equal((await call(ID)).status, 404);
});

const expoSnack = require('../../src/utils/builder/expo-snack');
const expoLayer = (re) => router.stack.find((l) => l.route && String(l.route.path) === String(re));

function callLayer(layerRef, id) {
  return new Promise((resolve, reject) => {
    const req = { params: { 0: id } };
    const res = {
      statusCode: 200,
      headers: {},
      status(c) { this.statusCode = c; return this; },
      set(h, v) { if (typeof h === 'string') this.headers[h] = v; else Object.assign(this.headers, h); return this; },
      type() { return this; },
      json(b) { resolve({ status: this.statusCode, json: b }); return this; },
      send(b) { resolve({ status: this.statusCode, headers: this.headers, body: String(b) }); return this; },
    };
    layerRef.route.stack.at(-1).handle(req, res, reject);
  });
}

test('Expo QR encodes the Snack exp:// link of an app template', async (t) => {
  t.mock.method(Product, 'findById', () => lean({ _id: ID, name: 'x', category: 'template-app', moderationStatus: 'active', published: true }));
  t.mock.method(BuilderTemplate, 'findOne', () => lean({ demoEnabled: true, kind: 'app', files: [{ path: 'App.js', content: '' }] }));
  const seen = [];
  t.mock.method(expoSnack, 'ensureSnack', async (key) => { seen.push(key); return { enabled: true, available: true, url: 'exp://u.expo.dev/x?snack=abc' }; });
  const json = await callLayer(expoLayer(/^\/([a-f0-9]{24})\/expo$/), ID);
  assert.equal(json.json.url, 'exp://u.expo.dev/x?snack=abc');
  const svg = await callLayer(expoLayer(/^\/([a-f0-9]{24})\/expo-qr\.svg$/), ID);
  assert.equal(svg.status, 200);
  assert.match(svg.body, /^<svg/);
  assert.deepEqual(seen, [`tpl:${ID}`, `tpl:${ID}`]);
});

test('Expo QR is 404 when no link could be published', async (t) => {
  t.mock.method(Product, 'findById', () => lean({ _id: ID, name: 'x', category: 'template-app', moderationStatus: 'active', published: true }));
  t.mock.method(BuilderTemplate, 'findOne', () => lean({ demoEnabled: true, kind: 'app', files: [{ path: 'App.js', content: '' }] }));
  t.mock.method(expoSnack, 'ensureSnack', async () => ({ enabled: true, available: false, url: '', error: 'SNACK_SAVE_FAILED' }));
  const svg = await callLayer(expoLayer(/^\/([a-f0-9]{24})\/expo-qr\.svg$/), ID);
  assert.equal(svg.status, 404);
});

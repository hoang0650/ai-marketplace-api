const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const BuilderProject = require('../../src/models/BuilderProject');
const router = require('../../src/routes/builder');

const route = (path, method) =>
  router.stack.find((l) => l.route?.path === path && l.route.methods[method]).route.stack.at(-1).handle;

function call(handle, id, body) {
  return new Promise((resolve, reject) => {
    const req = { params: { id }, body, user: { _id: new mongoose.Types.ObjectId() } };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      set() { return this; },
    };
    Promise.resolve(handle(req, res, reject)).catch(reject);
  });
}

function project() {
  return new BuilderProject({
    owner: new mongoose.Types.ObjectId(),
    name: 'Demo',
    kind: 'web',
    files: [{ path: 'index.html', content: '<h1>Hi</h1>' }],
    messages: [],
  });
}

test('local-prompt returns the same chat messages the server would send, no key involved', async (t) => {
  const doc = project();
  t.mock.method(BuilderProject, 'findOne', async () => doc);
  const id = String(doc._id);
  const r = await call(route('/projects/:id/local-prompt', 'post'), id, { prompt: 'Thêm nút liên hệ' });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.messages) && r.body.messages.length >= 2);
  assert.match(JSON.stringify(r.body.messages), /Thêm nút liên hệ/);
});

test('local-apply applies the browser-side model reply with provider "local"', async (t) => {
  const doc = project();
  t.mock.method(BuilderProject, 'findOne', async () => doc);
  t.mock.method(doc, 'save', async () => doc);
  const text = 'Đã đổi tiêu đề.\n\n```html file=index.html\n<h1>Xin chào</h1>\n```\n';
  const r = await call(route('/projects/:id/local-apply', 'post'), String(doc._id), { prompt: 'Đổi tiêu đề', text, model: 'llama3.1' });
  assert.equal(r.status, 200);
  assert.equal(doc.provider, 'local');
  assert.equal(doc.model, 'llama3.1');
  assert.equal(doc.messages.length, 2);
});

test('local-apply rejects an empty reply', async (t) => {
  const doc = project();
  t.mock.method(BuilderProject, 'findOne', async () => doc);
  const r = await call(route('/projects/:id/local-apply', 'post'), String(doc._id), { prompt: 'x', text: '  ' });
  assert.equal(r.status, 502);
  assert.match(JSON.stringify(r.body), /EMPTY_OUTPUT/);
});

test('PATCH accepts provider "local" without a stored key', async (t) => {
  const doc = project();
  t.mock.method(BuilderProject, 'findOne', async () => doc);
  t.mock.method(doc, 'save', async () => doc);
  const r = await call(route('/projects/:id', 'patch'), String(doc._id), { provider: 'local' });
  assert.equal(r.status, 200);
  assert.equal(doc.provider, 'local');
});

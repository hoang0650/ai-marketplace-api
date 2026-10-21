const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Order = require('../../src/models/Order');
const Product = require('../../src/models/Product');
const WalletTx = require('../../src/models/WalletTx');
const router = require('../../src/routes/billing');

const handler = router.stack.find((l) => l.route?.path === '/checkout').route.stack.at(-1).handle;

function call(body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      body,
      user: { _id: new mongoose.Types.ObjectId('6a69f0cdd7faa829b87a852e'), role: 'buyer', name: 'B' },
      get: (h) => headers[h] || headers[h.toLowerCase()],
      ip: '127.0.0.1',
    };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
    };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}

test('a retried checkout with the same Idempotency-Key returns the first order, no second charge', async (t) => {
  const prior = { _id: new mongoose.Types.ObjectId(), productName: 'Mây Homestay', quantity: 1, amount: 9, currency: 'USD' };
  t.mock.method(Order, 'findOne', (q) => ({ lean: async () => (q.idempotencyKey === 'chk-abcdef123456' ? prior : null) }));
  t.mock.method(WalletTx, 'aggregate', async () => [{ balance: 970.14 }]);
  const chain = () => new Proxy({}, { get: (_, k) => (k === 'then' ? (r) => r([]) : chain) });
  t.mock.method(Order, 'find', chain);
  // Holds/usage lookups in getAvailableBalance: no DB in unit tests.
  t.mock.method(mongoose.Model, 'aggregate', async () => []);
  t.mock.method(mongoose.Model, 'find', chain);
  t.mock.method(mongoose.Model, 'findOne', chain);
  const productFind = t.mock.method(Product, 'findById', async () => null);
  const create = t.mock.method(WalletTx, 'create', async () => ({}));
  const r = await call({ productId: String(new mongoose.Types.ObjectId()) }, { 'Idempotency-Key': 'chk-abcdef123456' });
  assert.equal(r.status, 200);
  assert.equal(r.body.duplicate, true);
  assert.equal(r.body.orderId, String(prior._id));
  assert.equal(r.body.amount, 9);
  assert.equal(typeof r.body.available, 'number');
  assert.equal(productFind.mock.callCount(), 0);
  assert.equal(create.mock.callCount(), 0);
});

test('a second concurrent click for the same product gets 409 instead of paying twice', async (t) => {
  const pid = String(new mongoose.Types.ObjectId());
  let release;
  t.mock.method(Order, 'findOne', () => ({ lean: async () => null }));
  t.mock.method(Product, 'findById', () => new Promise((r) => { release = () => r(null); }));
  const first = call({ productId: pid });
  await new Promise((r) => setImmediate(r));
  const second = await call({ productId: pid });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'CHECKOUT_IN_PROGRESS');
  release();
  const done = await first;
  assert.equal(done.status, 404);
  // Lock released after the first finished.
  t.mock.method(Product, 'findById', async () => null);
  assert.equal((await call({ productId: pid })).status, 404);
});

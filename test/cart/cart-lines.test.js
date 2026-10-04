const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyCartLine, removeCartLines, clampQty, MAX_QTY, MAX_LINES } = require('../../src/utils/cart');

const A = '507f1f77bcf86cd799439011';
const B = '507f1f77bcf86cd799439012';

test('clampQty floors and bounds to 0..99', () => {
  assert.equal(clampQty(2.7), 2);
  assert.equal(clampQty(-3), 0);
  assert.equal(clampQty(500), MAX_QTY);
  assert.equal(clampQty('abc'), 0);
});

test('add creates a line then increments it', () => {
  let items = applyCartLine([], A, 1, 'add');
  assert.deepEqual(items.map((i) => [i.product, i.qty]), [[A, 1]]);
  items = applyCartLine(items, A, 2, 'add');
  assert.deepEqual(items.map((i) => [i.product, i.qty]), [[A, 3]]);
  items = applyCartLine(items, A, 200, 'add');
  assert.equal(items[0].qty, MAX_QTY);
});

test('set overwrites qty and 0 removes the line', () => {
  const start = [{ product: { _id: A }, qty: 2 }, { product: B, qty: 1 }];
  const set = applyCartLine(start, A, 5, 'set');
  assert.deepEqual(set.map((i) => [i.product, i.qty]), [[A, 5], [B, 1]]);
  const removed = applyCartLine(set, A, 0, 'set');
  assert.deepEqual(removed.map((i) => i.product), [B]);
  assert.equal(start[0].qty, 2, 'input is not mutated');
});

test('removeCartLines drops listed ids (ObjectId or string forms)', () => {
  const items = [{ product: { _id: A }, qty: 1 }, { product: B, qty: 4 }];
  assert.deepEqual(removeCartLines(items, [A]).map((i) => i.product), [B]);
  assert.deepEqual(removeCartLines(items, []).length, 2);
});

test('cart rejects new lines beyond MAX_LINES', () => {
  const items = Array.from({ length: MAX_LINES }, (_, i) => ({ product: String(i).padStart(24, '0'), qty: 1 }));
  assert.throws(() => applyCartLine(items, A, 1, 'add'), /Cart is full/);
  assert.equal(applyCartLine(items, items[0].product, 1, 'add')[0].qty, 2);
});

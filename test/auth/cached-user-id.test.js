const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { asReqUser } = require('../../src/middleware/auth');

test('cached (JSON) user gets an ObjectId _id so aggregate $match works', () => {
  const id = new mongoose.Types.ObjectId();
  const user = asReqUser(JSON.parse(JSON.stringify({ _id: id, role: 'buyer' })));
  assert.ok(user._id instanceof mongoose.Types.ObjectId);
  assert.ok(user._id.equals(id));
});

test('cached user with only id is cast too', () => {
  const id = new mongoose.Types.ObjectId();
  const user = asReqUser({ id: String(id) });
  assert.ok(user._id instanceof mongoose.Types.ObjectId);
});

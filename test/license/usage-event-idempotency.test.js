const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const UsageEvent = require('../../src/models/UsageEvent');

function stubEvent() {
  return new UsageEvent({
    product: new mongoose.Types.ObjectId(),
    buyer: new mongoose.Types.ObjectId(),
    seller: new mongoose.Types.ObjectId(),
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    platformFee: 0,
    sellerNet: 0,
    source: 'playground',
  });
}

describe('UsageEvent idempotency', () => {
  test('playground runs get distinct keys instead of shared null', async () => {
    const a = stubEvent();
    const b = stubEvent();
    await a.validate();
    await b.validate();
    assert.match(a.idempotencyKey, /^ue_playground_/);
    assert.match(b.idempotencyKey, /^ue_playground_/);
    assert.notEqual(a.idempotencyKey, b.idempotencyKey);
  });

  test('keeps an explicit key', async () => {
    const row = stubEvent();
    row.idempotencyKey = 'AIM-CUSTOM-KEY';
    await row.validate();
    assert.equal(row.idempotencyKey, 'AIM-CUSTOM-KEY');
  });
});

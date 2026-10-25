const { test, describe, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');

// Swap the upstream client and auth before the routes destructure them.
const denglish = require('../../src/utils/denglish-client');
const auth = require('../../src/middleware/auth');
let inferImpl = async () => ({ ok: true, data: { text: 'hi' }, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, unit: 'tokens' } });
const inferCalls = [];
denglish.inferWithFallback = async (args) => {
  inferCalls.push(args);
  return inferImpl(args);
};
let currentUser = null;
auth.authenticate = (req, _res, next) => {
  req.user = currentUser;
  next();
};

const { installFakeLedger, restoreStubs } = require('../helpers/fake-ledger');
const Product = require('../../src/models/Product');
const LicenseKey = require('../../src/models/LicenseKey');
const aimxTts = require('../../src/utils/aimx-tts');
const playground = require('../../src/routes/playground');
const { meterAndInfer } = require('../../src/utils/gateway-infer');

const oid = () => new mongoose.Types.ObjectId();
const seller = oid();
const llm = {
  _id: oid(),
  slug: 'test-llm',
  name: '[TEST] LLM',
  category: 'inference',
  creator: seller,
  ownershipType: 'THIRD_PARTY_SELLER',
  runtime: { baseModel: 'openai/gpt-4o-mini', env: [{ key: 'UPSTREAM_PROVIDER', value: 'openrouter' }] },
  pricing: { model: 'usage', currency: 'USD', usageUnit: '1M tokens', usageRate: 1, inputRate: 1, outputRate: 4 },
};

let server;
let base;
let saved;
let db;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/playground', playground);
  app.use((err, _req, res, _next) => res.status(500).json({ message: err.message }));
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

beforeEach(() => {
  saved = [];
  db = installFakeLedger({ saved });
  inferCalls.length = 0;
  inferImpl = async () => ({ ok: true, data: { text: 'hi' }, usage: { input_tokens: 1_000_000, output_tokens: 250_000, total_tokens: 1_250_000, unit: 'tokens' } });
  currentUser = { _id: oid(), role: 'buyer' };
  const s = (obj, key, fn) => {
    saved.push([obj, key, obj[key]]);
    obj[key] = fn;
  };
  s(Product, 'findById', async (id) => ([llm, voiceProduct].find((p) => String(p._id) === String(id)) || null));
  s(Product, 'findOne', async () => null);
  const empty = { sort: () => empty, select: () => empty, limit: () => empty, lean: async () => [] };
  s(LicenseKey, 'find', () => empty);
  s(aimxTts, 'enabled', () => false);
});
afterEach(() => restoreStubs(saved));

const voiceProduct = {
  _id: oid(),
  slug: 'test-voice',
  name: '[TEST] Voice',
  category: 'voice-preset',
  creator: seller,
  ownershipType: 'THIRD_PARTY_SELLER',
  contentMeta: { presetVoiceName: 'mai' },
  pricing: { model: 'usage', currency: 'USD', usageUnit: '1K characters', usageRate: 1 },
};

const run = (body, headers = {}) =>
  fetch(`${base}/playground/run`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));

describe('playground /run', () => {
  test('bills 1M-token listing with split input/output prices', async () => {
    db.fund(currentUser._id, 5);
    const r = await run({ productId: String(llm._id), input: { prompt: 'hello' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.cost, 2); // 1M × $1 + 0.25M × $4
    assert.equal(db.balanceOf(currentUser._id), 3);
  });

  test('buyer provider / model / endpoint overrides are ignored', async () => {
    db.fund(currentUser._id, 5);
    const r = await run({ productId: String(llm._id), input: { prompt: 'x' }, provider: 'runpod_public', model: 'anthropic/claude-opus', endpointId: 'veiasbyphk9rrd' });
    assert.equal(r.status, 200);
    assert.notEqual(inferCalls[0].provider, 'runpod_public');
    assert.notEqual(inferCalls[0].model, 'anthropic/claude-opus');
    assert.notEqual(inferCalls[0].endpointId, 'veiasbyphk9rrd');
    assert.deepEqual([...r.body.ignoredOverrides].sort(), ['endpointId', 'model', 'provider']);
  });

  test('sandbox responses cost 0', async () => {
    db.fund(currentUser._id, 5);
    inferImpl = async () => ({ ok: true, raw: { sandbox: true }, data: { text: 'mock', cost: 9 }, usage: { input_tokens: 1_000_000, output_tokens: 0, unit: 'tokens' } });
    const r = await run({ productId: String(llm._id), input: { prompt: 'x' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.cost, 0);
    assert.equal(r.body.providerCost, 0);
    assert.equal(db.balanceOf(currentUser._id), 5);
  });

  test('402 with estimatedCost when available < estimate; nothing called or held', async () => {
    db.fund(currentUser._id, 0.000001);
    const r = await run({ productId: String(llm._id), input: { prompt: 'x'.repeat(4000) } });
    assert.equal(r.status, 402);
    assert.ok(r.body.estimatedCost > 0);
    assert.equal(inferCalls.length, 0);
    assert.equal(db.balanceOf(currentUser._id), 0.000001);
  });

  test('parallel runs never take the wallet negative', async () => {
    db.fund(currentUser._id, 3);
    inferImpl = async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true, data: { text: 'hi' }, usage: { input_tokens: 1_000_000, output_tokens: 250_000, unit: 'tokens' } };
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => run({ productId: String(llm._id), input: { prompt: 'p' } })));
    assert.ok(results.every((r) => [200, 402].includes(r.status)), JSON.stringify(results.map((r) => r.status)));
    assert.ok(db.balanceOf(currentUser._id) >= 0);
    const charged = results.reduce((s, r) => s + (r.body.cost || 0), 0);
    assert.ok(charged <= 3 + 1e-9);
  });

  test('Idempotency-Key: second call replays (no second charge); other buyer is independent', async () => {
    db.fund(currentUser._id, 10);
    const first = await run({ productId: String(llm._id), input: { prompt: 'p' } }, { 'Idempotency-Key': 'abc' });
    const second = await run({ productId: String(llm._id), input: { prompt: 'p' } }, { 'Idempotency-Key': 'abc' });
    assert.equal(first.body.cost, 2);
    assert.equal(second.body.replay, true);
    assert.equal(second.body.cost, 0);
    assert.equal(second.body.id, first.body.id);
    assert.equal(inferCalls.length, 1);
    assert.equal(db.balanceOf(currentUser._id), 8);
    assert.equal(inferCalls[0].idempotencyKey, `${currentUser._id}:abc`);
    const firstBuyer = currentUser;
    currentUser = { _id: oid(), role: 'buyer' };
    db.fund(currentUser._id, 10);
    const other = await run({ productId: String(llm._id), input: { prompt: 'p' } }, { 'Idempotency-Key': 'abc' });
    assert.notEqual(other.body.replay, true);
    assert.equal(inferCalls.length, 2);
    assert.equal(db.balanceOf(firstBuyer._id), 8);
  });

  test('concurrent calls with one key: one runs, the other gets 409', async () => {
    db.fund(currentUser._id, 10);
    inferImpl = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, data: { text: 'hi' }, usage: { input_tokens: 1_000_000, output_tokens: 0, unit: 'tokens' } };
    };
    const [a, b] = await Promise.all([
      run({ productId: String(llm._id), input: { prompt: 'p' } }, { 'Idempotency-Key': 'race' }),
      run({ productId: String(llm._id), input: { prompt: 'p' } }, { 'Idempotency-Key': 'race' }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(inferCalls.length, 1);
  });

  test('voice: empty text after trim → 400; NFC character billing', async () => {
    db.fund(currentUser._id, 5);
    const empty = await run({ productId: String(voiceProduct._id), input: { text: '   ' } });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.code, 'TEXT_REQUIRED');
    assert.equal(inferCalls.length, 0);
    inferImpl = async () => ({ ok: true, data: { audio_url: '' }, usage: { unit: 'characters', quantity: 999 } });
    const r = await run({ productId: String(voiceProduct._id), input: { text: 'Tie\u0302\u0301ng 😀' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.usage.quantity, 7);
    assert.equal(r.body.cost, 0.007);
  });
});

describe('gateway meterAndInfer', () => {
  const req = (headers = {}, body = {}) => ({ user: currentUser, headers, body, get: () => '', protocol: 'http' });

  test('ignores a buyer provider, bills split pricing, replays per buyer key', async () => {
    db.fund(currentUser._id, 10);
    const r1 = await meterAndInfer(req({ 'idempotency-key': 'g1' }, { provider: 'runpod_public' }), llm, { prompt: 'p' });
    assert.notEqual(inferCalls[0].provider, 'runpod_public');
    assert.equal(r1.charged, 2);
    const r2 = await meterAndInfer(req({ 'idempotency-key': 'g1' }), llm, { prompt: 'p' });
    assert.equal(r2.replay, true);
    assert.equal(r2.charged, 0);
    assert.equal(inferCalls.length, 1);
    assert.equal(db.balanceOf(currentUser._id), 8);
  });

  test('sandbox costs 0 and insufficient funds is a 402 before the upstream call', async () => {
    db.fund(currentUser._id, 1);
    inferImpl = async () => ({ ok: true, raw: { sandbox: true }, data: { text: 'm' }, usage: { input_tokens: 1_000_000, output_tokens: 0, unit: 'tokens' } });
    const r = await meterAndInfer(req(), llm, { prompt: 'p' });
    assert.equal(r.charged, 0);
    assert.equal(db.balanceOf(currentUser._id), 1);
    db.tx.length = 0;
    await assert.rejects(meterAndInfer(req(), llm, { prompt: 'x'.repeat(4000) }), { status: 402 });
  });
});

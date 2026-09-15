const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildComputeTestProducts } = require('../../src/data/compute-test-products');

test('compute test catalog has gpu-compute and game-server listings', () => {
  const rows = buildComputeTestProducts();
  const cats = new Set(rows.map((p) => p.category));
  assert.equal(cats.has('gpu-compute'), true);
  assert.equal(cats.has('game-server'), true);
  assert.ok(rows.length >= 6);
  for (const p of rows) {
    assert.ok(p.slug);
    assert.ok(p.node?.providerServerId?.startsWith('testnode-'));
    assert.ok(p.node.kind === 'compute' || p.node.kind === 'game');
  }
  assert.ok(rows.some((p) => p.pricing.model === 'free'));
  assert.ok(rows.some((p) => p.slug === 'game-sandbox-arcade'));
  assert.ok(rows.some((p) => p.slug === 'gpu-sandbox-lab'));
});

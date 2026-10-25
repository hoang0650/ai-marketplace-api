const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildComputeTestProducts, RETIRED_GAME_SLUGS } = require('../../src/data/compute-test-products');
const { buildGameServerProducts } = require('../../src/data/game-server-products');

test('compute test catalog has gpu-compute listings; game servers are real dedicated listings', () => {
  const rows = buildComputeTestProducts();
  const cats = new Set(rows.map((p) => p.category));
  assert.equal(cats.has('gpu-compute'), true);
  assert.equal(cats.has('game-server'), false);
  assert.ok(rows.length >= 4);
  for (const p of rows) {
    assert.ok(p.slug);
    assert.ok(p.node?.providerServerId?.startsWith('testnode-'));
    assert.equal(p.node.kind, 'compute');
  }
  assert.ok(rows.some((p) => p.pricing.model === 'free'));
  assert.ok(rows.some((p) => p.slug === 'gpu-sandbox-lab'));
  assert.deepEqual(RETIRED_GAME_SLUGS, ['game-sandbox-arcade', 'game-cloud-desktop', 'game-indie-box']);
  const games = buildGameServerProducts();
  assert.ok(games.length >= 3);
  assert.ok(games.every((g) => g.category === 'game-server' && g.gameServer?.image && g.gameServer.port > 0));
});

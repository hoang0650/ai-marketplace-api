const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { publicProvider, internalProvider, publicRegistryRow, PUBLIC_REGION } = require('../../src/utils/white-label');
const { mapUsageEvent } = require('../../src/utils/buyer-usage');

const SRC = path.join(__dirname, '../../src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

test('seeded user-facing copy does not name the GPU vendor', () => {
  for (const [file, needle] of [
    ['utils/ensure-ai-provider-products.js', /bio: '[^']*runpod/i],
    ['scripts/seed-banners.js', /subtitle: '[^']*runpod/i],
    ['utils/seller-compliance.js', /'[^']*\bRunPod\b[^']*'/],
    ['terminal/gateway.js', /'[^']*\bRunPod\b[^']*'/],
  ]) {
    assert.doesNotMatch(read(file), needle, file);
  }
});

test('serverless provider and node region are white-labeled', () => {
  assert.equal(publicProvider('runpod_serverless'), 'aimarkets-serverless');
  assert.equal(internalProvider('aimarkets-serverless'), 'runpod_serverless');
  assert.doesNotMatch(PUBLIC_REGION, /runpod/i);
  const row = publicRegistryRow({ provider: 'runpod_serverless', adapter: 'runpod_serverless', label: 'RunPod Serverless' });
  assert.doesNotMatch(JSON.stringify(row), /runpod/i);
});

test('buyer usage feed shows the public provider alias', () => {
  const item = mapUsageEvent({ _id: 'x', provider: 'runpod_public', source: 'playground' });
  assert.equal(item.model, 'aimarkets-endpoints');
});

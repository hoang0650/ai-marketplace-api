const test = require('node:test');
const assert = require('node:assert');
const { gpuConfig, providerPath } = require('../../src/utils/aimx-gpu');

test('GPU calls go to the AI service provider routes, never straight to the 5090', () => {
  assert.equal(providerPath('/v1/video/fast'), '/providers/aimx/jobs/fast');
  assert.equal(providerPath('/v1/train'), '/providers/aimx/jobs/train');
  assert.equal(providerPath('/v1/voices'), '/providers/aimx/voices');
  const id = 'a'.repeat(32);
  assert.equal(providerPath(`/v1/jobs/${id}`), `/providers/aimx/jobs/${id}`);
  assert.equal(providerPath(`/v1/jobs/${id}/cancel`), `/providers/aimx/jobs/${id}/cancel`);
  assert.equal(providerPath(`/v1/files/${id}.mp4`), `/providers/aimx/files/${id}.mp4`);
  assert.equal(providerPath('/v1/files/../../etc/passwd'), null);
  assert.equal(providerPath('/admin'), null);
});

test('config needs the AI service URL + service key; GPU_STUDIO_* is ignored', () => {
  assert.equal(gpuConfig({ GPU_STUDIO_URL: 'http://x', GPU_STUDIO_TOKEN: 't' }).enabled, false);
  assert.equal(gpuConfig({ AIMX_PROVIDER_URL: 'http://ai:8000/', DENGLISH_SERVICE_KEY: 'k' }).url, 'http://ai:8000');
  assert.equal(gpuConfig({ AIMX_PROVIDER_URL: 'http://ai:8000', DENGLISH_SERVICE_KEY: 'k' }).enabled, true);
  assert.equal(gpuConfig({ AIMX_PROVIDER_URL: 'http://ai:8000', DENGLISH_SERVICE_KEY: 'k', AIMX_STUDIO: 'off' }).enabled, false);
});

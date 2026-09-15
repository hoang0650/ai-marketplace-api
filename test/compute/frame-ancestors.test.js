const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isGamePlayerPath } = require('../../src/utils/frame-ancestors');

test('game player and proxy paths are detected for iframe allow', () => {
  assert.equal(isGamePlayerPath('/v1/game-sessions/gs_abc/player?access_token=x'), true);
  assert.equal(isGamePlayerPath('/v1/game-sessions/gs_abc/proxy/vnc.html'), true);
  assert.equal(isGamePlayerPath('/v1/products'), false);
});

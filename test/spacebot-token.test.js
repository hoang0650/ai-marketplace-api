const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SPACEBOT_DASHBOARD_TOKEN_SEED = 'seed';
delete process.env.AIMARKETS_SERVICE_SECRET;

const { dashboardTokenForUser } = require('../src/utils/spacebot-token');

const USER = '6a69f0cdd7faa829b87a852e';

test('dashboard token is per buyer and matches the SpaceBot HMAC', () => {
  const token = dashboardTokenForUser(USER);
  assert.equal(token, 'c055dc1db2aff38bf2f89f5213586697b16f1e4daed8b02f');
  assert.equal(token, dashboardTokenForUser(USER.toUpperCase()));
  assert.notEqual(token, dashboardTokenForUser('6a69f0cdd7faa829b87a852f'));
  assert.equal(dashboardTokenForUser('not-a-user'), '');
});

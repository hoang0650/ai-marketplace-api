const test = require('node:test');
const assert = require('node:assert/strict');
const { aimarketsGatewayToken } = require('../src/utils/openclaw-ticket');

function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('AI Markets gateway token matches the OpenClaw gateway derivation', () => {
  withEnv(
    { AIMARKETS_SERVICE_SECRET: 'service-secret', OPENCLAW_MARKET_TICKET_SECRET: 'ticket-secret' },
    () => {
      // Same vector as openclaw src/gateway/aimarkets-ticket.test.ts.
      assert.equal(aimarketsGatewayToken(), 'd2acf1f3372abe6942578a088ea811b39e1f14f85dabf74b');
    }
  );
});

test('AI Markets gateway token is empty unless both secrets are set', () => {
  withEnv({ AIMARKETS_SERVICE_SECRET: 'service-secret', OPENCLAW_MARKET_TICKET_SECRET: undefined }, () => {
    assert.equal(aimarketsGatewayToken(), '');
  });
  withEnv({ AIMARKETS_SERVICE_SECRET: undefined, OPENCLAW_MARKET_TICKET_SECRET: 'ticket-secret' }, () => {
    assert.equal(aimarketsGatewayToken(), '');
  });
});


test('browser gateway credential does not inherit the separate PHHotel tenant seed', () => {
  withEnv({ AIMARKETS_SERVICE_SECRET: 'service-secret', OPENCLAW_MARKET_TICKET_SECRET: 'ticket-secret', PYTHON_AI_SHARED_SECRET: 'separate-phhotel-secret' }, () => {
    const { tenantGatewayToken, issueMarketTicket, verifyMarketTicket } = require('../src/utils/openclaw-ticket');
    const uid = '0123456789abcdef01234567';
    assert.equal(aimarketsGatewayToken(), 'd2acf1f3372abe6942578a088ea811b39e1f14f85dabf74b');
    assert.notEqual(aimarketsGatewayToken(), tenantGatewayToken(uid));
    assert.equal(verifyMarketTicket(issueMarketTicket(uid)), uid);
  });
});

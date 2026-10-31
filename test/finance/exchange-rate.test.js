const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  getExchangeRates,
  setAdminOverride,
  getAdminExchangeRates,
  currentVndPerUsd,
  resetExchangeRates,
  setExchangeRateFetcher,
  fxAudit,
} = require('../../src/finance/exchange-rate');
const { toUsd } = require('../../src/utils/usage-pricing');

function payload(vnd, cny, unix = 1_700_000_000) {
  return {
    result: 'success',
    conversion_rates: { USD: 1, VND: vnd, CNY: cny },
    time_last_update_unix: unix,
  };
}

function okFetch(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

function restoreEnv(t, key) {
  const prev = process.env[key];
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

test('provider quote is cached for the TTL and exposes source + updatedAt', async (t) => {
  t.after(() => resetExchangeRates());
  restoreEnv(t, 'EXCHANGE_RATE_TTL_MS');
  process.env.EXCHANGE_RATE_TTL_MS = '3600000';
  let calls = 0;
  setExchangeRateFetcher(async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => payload(26123.5, 7.123456) };
  });
  const first = await getExchangeRates();
  const second = await getExchangeRates();
  assert.equal(calls, 1);
  assert.equal(first.provider, 'exchangerate-api');
  assert.equal(first.vndPerUsd, 26123.5);
  assert.equal(first.cnyPerUsd, 7.123456);
  assert.equal(first.source, 'exchangerate-api');
  assert.equal(first.updatedAt, new Date(1_700_000_000 * 1000).toISOString());
  assert.equal(first.stale, false);
  assert.equal(first.rates.USD, 1);
  assert.deepEqual(second.vndPerUsd, first.vndPerUsd);
  assert.equal(currentVndPerUsd(), 26123.5);
});

test('a failed refresh keeps the last good rate; with none, the env fallback and a warning', async (t) => {
  t.after(() => resetExchangeRates());
  restoreEnv(t, 'EXCHANGE_RATE_TTL_MS');
  restoreEnv(t, 'EXCHANGE_RATE_RETRY_MS');
  restoreEnv(t, 'VND_USD_RATE');
  restoreEnv(t, 'EXCHANGE_RATE_API_KEY');
  process.env.EXCHANGE_RATE_TTL_MS = '0';
  process.env.EXCHANGE_RATE_RETRY_MS = '0';
  delete process.env.VND_USD_RATE;
  process.env.EXCHANGE_RATE_API_KEY = 'super-secret-key';

  setExchangeRateFetcher(okFetch(payload(25000, 7.2)));
  const live = await getExchangeRates();
  assert.equal(live.vndPerUsd, 25000);

  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  t.after(() => {
    console.warn = orig;
  });

  setExchangeRateFetcher(async () => {
    throw new Error('network down super-secret-key');
  });
  const cached = await getExchangeRates();
  assert.equal(cached.source, 'cache');
  assert.equal(cached.vndPerUsd, 25000);
  assert.equal(cached.stale, true);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /last cached/);
  assert.equal(warns[0].includes('super-secret-key'), false);

  resetExchangeRates();
  setExchangeRateFetcher(async () => {
    throw new Error('still down');
  });
  const fallback = await getExchangeRates();
  assert.equal(fallback.source, 'fallback');
  assert.equal(fallback.vndPerUsd, 26500);
  assert.equal(fallback.cnyPerUsd, 7.25);
  assert.match(warns[1], /fallback/);
});

test('env override then admin override win; clearing the admin override returns to env', async (t) => {
  t.after(() => resetExchangeRates());
  restoreEnv(t, 'EXCHANGE_RATE_VND_OVERRIDE');
  restoreEnv(t, 'EXCHANGE_RATE_CNY_OVERRIDE');
  process.env.EXCHANGE_RATE_VND_OVERRIDE = '27000';
  process.env.EXCHANGE_RATE_CNY_OVERRIDE = '7.5';
  setExchangeRateFetcher(okFetch(payload(25000, 7.1)));
  const envQuote = await getExchangeRates();
  assert.equal(envQuote.source, 'override');
  assert.equal(envQuote.vndPerUsd, 27000);
  assert.equal(envQuote.cnyPerUsd, 7.5);

  await setAdminOverride({ vndPerUsd: 28000 });
  const adminQuote = await getAdminExchangeRates();
  assert.equal(adminQuote.vndPerUsd, 28000);
  assert.equal(adminQuote.cnyPerUsd, 7.5);
  assert.equal(adminQuote.override.vndPerUsd, 28000);
  assert.equal(adminQuote.live.vndPerUsd, 25000);
  assert.equal(fxAudit(adminQuote).exchangeRateSource, 'override');
  assert.equal(fxAudit(adminQuote).vndPerUsd, 28000);

  const cleared = await setAdminOverride({ vndPerUsd: null });
  assert.equal(cleared.vndPerUsd, 27000);
  assert.equal(cleared.override.vndPerUsd, null);
});

test('USD list prices are not converted; VND and CNY use the live rate', async (t) => {
  t.after(() => resetExchangeRates());
  setExchangeRateFetcher(okFetch(payload(25000, 7.1)));
  await getExchangeRates();
  assert.equal(toUsd(12.5, 'USD'), 12.5);
  assert.equal(toUsd(25000, 'VND'), 1);
  assert.equal(Math.round(toUsd(7.1, 'CNY') * 1e6) / 1e6, 1);
});

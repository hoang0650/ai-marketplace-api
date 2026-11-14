/**
 * Live USD exchange rates from ExchangeRate-API
 * (https://www.exchangerate-api.com):
 *   GET https://v6.exchangerate-api.com/v6/<EXCHANGE_RATE_API_KEY>/latest/USD
 *
 *   1. optional admin override, then optional env override
 *   2. a fresh provider quote, refreshed at most every 6–12 hours
 *   3. the last good quote (memory, then MongoDB) if the provider errors
 *
 * There is no built-in VND or CNY figure. If no rate has ever been fetched
 * and the provider fails, callers get `available: false` and
 * `EXCHANGE_RATE_UNAVAILABLE`.
 *
 * The API key is read from EXCHANGE_RATE_API_KEY. It is never embedded here.
 */
const mongoose = require('mongoose');
const ExchangeRate = require('../models/ExchangeRate');
const { overrideVndPerUsd, overrideCnyPerUsd } = require('../config/fx');

const PROVIDER = 'exchangerate-api';
const SOURCE = 'exchangerate-api.com';
const MIN_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_TTL_MS = 12 * 60 * 60 * 1000;
const EMPTY_RETRY_MS = 15 * 60 * 1000;

function emptyState() {
  return {
    provider: null,
    admin: { vnd: null, cny: null, updatedAt: null },
    dbLoaded: false,
    inflight: null,
    nextAttemptAt: 0,
    warned: false,
  };
}

let state = emptyState();
/** Test hook. Production uses global fetch. */
let fetchImpl = null;

function inTest() {
  return !!process.env.NODE_TEST_CONTEXT;
}

function ttlMs() {
  const n = Number(process.env.EXCHANGE_RATE_TTL_MS);
  if (inTest() && Number.isFinite(n) && n >= 0) return n;
  if (Number.isFinite(n) && n > 0) return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, n));
  return MAX_TTL_MS;
}

function retryMs() {
  const n = Number(process.env.EXCHANGE_RATE_RETRY_MS);
  if (inTest() && Number.isFinite(n) && n >= 0) return n;
  if (Number.isFinite(n) && n > 0) return Math.max(MIN_TTL_MS, n);
  return MIN_TTL_MS;
}

function timeoutMs() {
  const n = Number(process.env.EXCHANGE_RATE_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 500 ? n : 4000;
}

function apiKey() {
  return String(process.env.EXCHANGE_RATE_API_KEY || '').trim();
}

function networkAllowed() {
  const off = String(process.env.EXCHANGE_RATE_DISABLE || '').toLowerCase();
  if (off === '1' || off === 'true' || off === 'yes') return false;
  if (fetchImpl) return true;
  if (inTest()) return false;
  if (!apiKey()) return false;
  return typeof globalThis.fetch === 'function';
}

function roundRate(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * 1e6) / 1e6;
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function providerUrl() {
  const key = apiKey();
  if (key) return `https://v6.exchangerate-api.com/v6/${encodeURIComponent(key)}/latest/USD`;
  if (fetchImpl) return 'https://v6.exchangerate-api.com/v6/test/latest/USD';
  throw new Error('EXCHANGE_RATE_API_KEY is not set');
}

function safeError(err) {
  const key = apiKey();
  let msg = err?.name === 'AbortError' ? 'timed out' : String(err?.message || err || 'request failed');
  if (key) msg = msg.split(key).join('[redacted]');
  return msg.slice(0, 200);
}

function exchangeRateUnavailableError() {
  const err = new Error(
    'Exchange rate is unavailable. Conversion waits for a rate from ExchangeRate-API (https://www.exchangerate-api.com).',
  );
  err.status = 503;
  err.code = 'EXCHANGE_RATE_UNAVAILABLE';
  return err;
}

function isFresh(now = Date.now()) {
  const fetched = state.provider?.fetchedAt ? Date.parse(state.provider.fetchedAt) : 0;
  return fetched > 0 && now - fetched < ttlMs();
}

function pick(currency) {
  const admin = currency === 'vnd' ? state.admin.vnd : state.admin.cny;
  const envOverride = currency === 'vnd' ? overrideVndPerUsd() : overrideCnyPerUsd();
  if (admin > 0) {
    return { rate: admin, source: 'override', updatedAt: state.admin.updatedAt, stale: false };
  }
  if (envOverride) {
    return { rate: envOverride, source: 'override', updatedAt: null, stale: false };
  }
  const live = currency === 'vnd' ? state.provider?.vndPerUsd : state.provider?.cnyPerUsd;
  if (live > 0) {
    const fresh = isFresh();
    return {
      rate: live,
      source: SOURCE,
      updatedAt: state.provider.updatedAt,
      stale: !fresh,
    };
  }
  return { rate: null, source: null, updatedAt: null, stale: false };
}

function publicQuote() {
  const vnd = pick('vnd');
  const cny = pick('cny');
  const available = vnd.rate > 0;
  const fetchedAt = vnd.source === 'override'
    ? (vnd.updatedAt || state.provider?.fetchedAt || null)
    : (state.provider?.fetchedAt || null);
  return {
    base: 'USD',
    provider: PROVIDER,
    available,
    error: available ? null : 'EXCHANGE_RATE_UNAVAILABLE',
    vndPerUsd: vnd.rate,
    cnyPerUsd: cny.rate,
    rates: { USD: 1, VND: vnd.rate, CNY: cny.rate },
    source: vnd.source,
    updatedAt: vnd.updatedAt,
    fetchedAt,
    stale: Boolean(vnd.stale),
    currencies: {
      VND: { rate: vnd.rate, source: vnd.source, updatedAt: vnd.updatedAt },
      CNY: { rate: cny.rate, source: cny.source, updatedAt: cny.updatedAt },
    },
  };
}

/** Public GET /v1/exchange-rates body. No invented figure when the rate is missing. */
function toPublicExchangeRate(quote = publicQuote()) {
  const body = {
    base: 'USD',
    rates: {
      USD: 1,
      VND: quote?.vndPerUsd > 0 ? quote.vndPerUsd : null,
      CNY: quote?.cnyPerUsd > 0 ? quote.cnyPerUsd : null,
    },
    source: quote?.available ? quote.source : null,
    updatedAt: quote?.available ? (quote.updatedAt || null) : null,
    fetchedAt: quote?.available ? (quote.fetchedAt || null) : null,
    stale: Boolean(quote?.stale),
    available: Boolean(quote?.available),
  };
  if (!body.available) {
    return {
      status: 503,
      body: {
        ...body,
        error: 'EXCHANGE_RATE_UNAVAILABLE',
        message: exchangeRateUnavailableError().message,
      },
    };
  }
  return {
    status: 200,
    body: {
      ...body,
      vndPerUsd: quote.vndPerUsd,
      cnyPerUsd: quote.cnyPerUsd,
      provider: PROVIDER,
      clientMustNotPrice: true,
      authoritativeQuotePath: '/v1/exchange-rates/quote',
    },
  };
}

function recordFromQuote(quote) {
  if (!(Number(quote?.vndPerUsd) > 0)) return null;
  return {
    base: 'USD',
    vndPerUsd: quote.vndPerUsd,
    cnyPerUsd: Number(quote.cnyPerUsd) > 0 ? quote.cnyPerUsd : null,
    source: quote.source || null,
    updatedAt: quote.updatedAt || null,
    fetchedAt: quote.fetchedAt || null,
  };
}

/** Fields copied onto a wallet transaction / payout for audit. */
function fxAudit(quote = publicQuote()) {
  if (!(Number(quote?.vndPerUsd) > 0)) {
    return {
      vndPerUsd: null,
      cnyPerUsd: null,
      exchangeRateSource: null,
      exchangeRateUpdatedAt: null,
      exchangeRateFetchedAt: null,
    };
  }
  return {
    vndPerUsd: quote.vndPerUsd,
    cnyPerUsd: Number(quote.cnyPerUsd) > 0 ? quote.cnyPerUsd : null,
    exchangeRateSource: quote.source,
    exchangeRateUpdatedAt: quote.updatedAt || null,
    exchangeRateFetchedAt: quote.fetchedAt || null,
  };
}

function currentVndPerUsd() {
  return pick('vnd').rate;
}

function currentCnyPerUsd() {
  return pick('cny').rate;
}

async function loadDbOnce() {
  if (state.dbLoaded) return;
  if (mongoose.connection.readyState !== 1) return;
  state.dbLoaded = true;
  try {
    const doc = await ExchangeRate.findOne({ key: 'current' }).lean();
    if (!doc) return;
    const dbFetched = doc.fetchedAt ? new Date(doc.fetchedAt).getTime() : 0;
    const memFetched = state.provider?.fetchedAt ? Date.parse(state.provider.fetchedAt) : 0;
    if (doc.vndPerUsd > 0 && dbFetched >= memFetched) {
      state.provider = {
        vndPerUsd: doc.vndPerUsd,
        cnyPerUsd: roundRate(doc.cnyPerUsd),
        updatedAt: iso(doc.providerUpdatedAt),
        fetchedAt: iso(doc.fetchedAt),
      };
    }
    if (doc.overrideVndPerUsd > 0 || doc.overrideCnyPerUsd > 0 || doc.overrideUpdatedAt) {
      state.admin = {
        vnd: doc.overrideVndPerUsd > 0 ? doc.overrideVndPerUsd : null,
        cny: doc.overrideCnyPerUsd > 0 ? doc.overrideCnyPerUsd : null,
        updatedAt: iso(doc.overrideUpdatedAt),
      };
    }
  } catch (err) {
    state.dbLoaded = false;
    console.warn('[exchange-rate] cache read failed:', safeError(err));
  }
}

async function persist() {
  if (mongoose.connection.readyState !== 1) return;
  const $set = {
    overrideVndPerUsd: state.admin.vnd,
    overrideCnyPerUsd: state.admin.cny,
    overrideUpdatedAt: state.admin.updatedAt ? new Date(state.admin.updatedAt) : null,
  };
  if (state.provider?.vndPerUsd > 0) {
    $set.vndPerUsd = state.provider.vndPerUsd;
    $set.cnyPerUsd = state.provider.cnyPerUsd ?? null;
    $set.providerUpdatedAt = state.provider.updatedAt ? new Date(state.provider.updatedAt) : null;
    $set.fetchedAt = state.provider.fetchedAt ? new Date(state.provider.fetchedAt) : null;
  }
  try {
    await ExchangeRate.updateOne({ key: 'current' }, { $set }, { upsert: true });
  } catch (err) {
    console.warn('[exchange-rate] cache write failed:', safeError(err));
  }
}

function providerUpdatedAt(data) {
  const utc = data?.time_last_update_utc ? new Date(data.time_last_update_utc) : null;
  if (utc && !Number.isNaN(utc.getTime())) return utc.toISOString();
  const unix = Number(data?.time_last_update_unix);
  if (Number.isFinite(unix) && unix > 0) return new Date(unix * 1000).toISOString();
  return new Date().toISOString();
}

async function fetchFromProvider() {
  const timeout = timeoutMs();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await (fetchImpl || globalThis.fetch)(providerUrl(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`ExchangeRate-API HTTP ${res.status}`);
    const data = await res.json();
    const table = data?.conversion_rates || data?.rates;
    if (data?.result !== 'success' || !table) throw new Error('ExchangeRate-API returned an unexpected payload');
    const vnd = roundRate(table.VND);
    const cny = roundRate(table.CNY);
    if (!vnd) throw new Error('ExchangeRate-API payload has no VND rate');
    return {
      vndPerUsd: vnd,
      cnyPerUsd: cny,
      updatedAt: providerUpdatedAt(data),
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function refreshIfDue() {
  if (!networkAllowed()) return;
  if (isFresh()) return;
  if (Date.now() < state.nextAttemptAt) return;
  if (state.inflight) return state.inflight;
  state.inflight = (async () => {
    try {
      state.provider = await fetchFromProvider();
      state.nextAttemptAt = 0;
      state.warned = false;
      await persist();
    } catch (err) {
      const delay = state.provider ? retryMs() : (inTest() ? retryMs() : Math.min(retryMs(), EMPTY_RETRY_MS));
      state.nextAttemptAt = Date.now() + delay;
      if (!state.warned) {
        state.warned = true;
        const using = state.provider ? 'last good rate' : 'no persisted rate';
        console.warn(`[exchange-rate] provider failed (${safeError(err)}); ${using}`);
      }
    } finally {
      state.inflight = null;
    }
  })();
  return state.inflight;
}

async function getExchangeRates() {
  await loadDbOnce();
  await refreshIfDue();
  return publicQuote();
}

/** Startup seed: one fetch. A failure keeps the last persisted rate or reports unavailable. */
async function warmExchangeRates() {
  const quote = await getExchangeRates();
  await persist();
  return quote;
}

/**
 * Admin override. `null` clears a side; omit a key to leave it unchanged.
 * Stored in memory and, when Mongo is up, in the exchange_rates collection.
 */
async function setAdminOverride({ vndPerUsd, cnyPerUsd } = {}) {
  if (vndPerUsd !== undefined) state.admin.vnd = vndPerUsd;
  if (cnyPerUsd !== undefined) state.admin.cny = cnyPerUsd;
  state.admin.updatedAt = new Date().toISOString();
  await persist();
  return adminView();
}

function adminView() {
  const quote = publicQuote();
  return {
    ...quote,
    override: {
      vndPerUsd: state.admin.vnd,
      cnyPerUsd: state.admin.cny,
      updatedAt: state.admin.updatedAt,
    },
    envOverride: {
      vndPerUsd: overrideVndPerUsd(),
      cnyPerUsd: overrideCnyPerUsd(),
    },
    live: state.provider
      ? {
          vndPerUsd: state.provider.vndPerUsd,
          cnyPerUsd: state.provider.cnyPerUsd,
          updatedAt: state.provider.updatedAt,
          fetchedAt: state.provider.fetchedAt,
        }
      : null,
  };
}

async function getAdminExchangeRates() {
  await loadDbOnce();
  await refreshIfDue();
  return adminView();
}

function resetExchangeRates() {
  state = emptyState();
  fetchImpl = null;
}

function setExchangeRateFetcher(fn) {
  fetchImpl = fn;
}

module.exports = {
  PROVIDER,
  SOURCE,
  MIN_TTL_MS,
  MAX_TTL_MS,
  getExchangeRates,
  warmExchangeRates,
  getAdminExchangeRates,
  setAdminOverride,
  currentVndPerUsd,
  currentCnyPerUsd,
  publicQuote,
  toPublicExchangeRate,
  recordFromQuote,
  fxAudit,
  exchangeRateUnavailableError,
  resetExchangeRates,
  setExchangeRateFetcher,
};

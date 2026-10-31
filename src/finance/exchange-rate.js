/**
 * Live USD exchange rates, same provider PHHotel uses.
 *
 * PHHotel's web app calls ExchangeRate-API v6 (`/latest/USD`) and keeps the
 * result in memory for 1 hour, then falls back to baked-in defaults. This
 * service does the same on the server:
 *   1. optional admin override, then optional env override
 *   2. a fresh provider quote (memory, refreshed at most once per TTL)
 *   3. the last good quote (memory, then MongoDB) if the provider errors
 *   4. VND_USD_RATE / CNY_PER_USD (defaults 26500 and 7.25) only when the
 *      provider has never succeeded — and a warning is logged
 *
 * EXCHANGE_RATE_API_KEY selects the authenticated v6 URL PHHotel calls.
 * Without a key the same provider's open endpoint is used (no secret in code).
 */
const mongoose = require('mongoose');
const ExchangeRate = require('../models/ExchangeRate');
const {
  fallbackVndPerUsd,
  fallbackCnyPerUsd,
  overrideVndPerUsd,
  overrideCnyPerUsd,
} = require('../config/fx');

const PROVIDER = 'exchangerate-api';

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

function ttlMs() {
  const n = Number(process.env.EXCHANGE_RATE_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 60 * 60 * 1000;
}

function retryMs() {
  const n = Number(process.env.EXCHANGE_RATE_RETRY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 60 * 1000;
}

function timeoutMs() {
  const n = Number(process.env.EXCHANGE_RATE_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 500 ? n : 4000;
}

function networkAllowed() {
  const off = String(process.env.EXCHANGE_RATE_DISABLE || '').toLowerCase();
  if (off === '1' || off === 'true' || off === 'yes') return false;
  if (fetchImpl) return true;
  // Unit tests must not call the network unless they inject a fetcher.
  if (process.env.NODE_TEST_CONTEXT) return false;
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
  const key = String(process.env.EXCHANGE_RATE_API_KEY || '').trim();
  if (key) return `https://v6.exchangerate-api.com/v6/${encodeURIComponent(key)}/latest/USD`;
  return 'https://open.er-api.com/v6/latest/USD';
}

function safeError(err) {
  const key = String(process.env.EXCHANGE_RATE_API_KEY || '').trim();
  let msg = err?.name === 'AbortError' ? 'timed out' : String(err?.message || err || 'request failed');
  if (key) msg = msg.split(key).join('[redacted]');
  return msg.slice(0, 200);
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
      source: fresh ? PROVIDER : 'cache',
      updatedAt: state.provider.updatedAt,
      stale: !fresh,
    };
  }
  const fallback = currency === 'vnd' ? fallbackVndPerUsd() : fallbackCnyPerUsd();
  return { rate: fallback, source: 'fallback', updatedAt: null, stale: false };
}

function publicQuote() {
  const vnd = pick('vnd');
  const cny = pick('cny');
  return {
    base: 'USD',
    provider: PROVIDER,
    vndPerUsd: vnd.rate,
    cnyPerUsd: cny.rate,
    rates: { USD: 1, VND: vnd.rate, CNY: cny.rate },
    source: vnd.source,
    updatedAt: vnd.updatedAt,
    stale: vnd.stale,
    currencies: {
      VND: { rate: vnd.rate, source: vnd.source, updatedAt: vnd.updatedAt },
      CNY: { rate: cny.rate, source: cny.source, updatedAt: cny.updatedAt },
    },
  };
}

/** Fields copied onto a wallet transaction / payout for audit. */
function fxAudit(quote = publicQuote()) {
  return {
    vndPerUsd: quote.vndPerUsd,
    cnyPerUsd: quote.cnyPerUsd,
    exchangeRateSource: quote.source,
    exchangeRateUpdatedAt: quote.updatedAt || null,
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
  try {
    await ExchangeRate.updateOne(
      { key: 'current' },
      {
        $set: {
          vndPerUsd: state.provider?.vndPerUsd ?? null,
          cnyPerUsd: state.provider?.cnyPerUsd ?? null,
          providerUpdatedAt: state.provider?.updatedAt ? new Date(state.provider.updatedAt) : null,
          fetchedAt: state.provider?.fetchedAt ? new Date(state.provider.fetchedAt) : null,
          overrideVndPerUsd: state.admin.vnd,
          overrideCnyPerUsd: state.admin.cny,
          overrideUpdatedAt: state.admin.updatedAt ? new Date(state.admin.updatedAt) : null,
        },
      },
      { upsert: true },
    );
  } catch (err) {
    console.warn('[exchange-rate] cache write failed:', safeError(err));
  }
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
    const updatedAt = data.time_last_update_unix
      ? new Date(Number(data.time_last_update_unix) * 1000).toISOString()
      : new Date().toISOString();
    return {
      vndPerUsd: vnd,
      cnyPerUsd: cny,
      updatedAt,
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
      state.nextAttemptAt = Date.now() + retryMs();
      if (!state.warned) {
        state.warned = true;
        const using = state.provider ? 'last cached' : 'fallback';
        console.warn(`[exchange-rate] provider failed (${safeError(err)}); using ${using} rate`);
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
    fallback: {
      vndPerUsd: fallbackVndPerUsd(),
      cnyPerUsd: fallbackCnyPerUsd(),
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
  getExchangeRates,
  warmExchangeRates,
  getAdminExchangeRates,
  setAdminOverride,
  currentVndPerUsd,
  currentCnyPerUsd,
  publicQuote,
  fxAudit,
  resetExchangeRates,
  setExchangeRateFetcher,
};

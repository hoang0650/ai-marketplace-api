/**
 * Last-resort VND↔USD and CNY↔USD numbers.
 *
 * Live rates come from ExchangeRate-API (the same provider PHHotel uses:
 * `https://v6.exchangerate-api.com/v6/{key}/latest/USD`, cached 1 hour) via
 * `src/finance/exchange-rate.js`. These defaults apply only when that provider
 * has never succeeded and there is no cached rate.
 *
 * Fallback env: VND_USD_RATE (default 26500), CNY_PER_USD (default 7.25).
 * Optional hard overrides (win over the live rate): EXCHANGE_RATE_VND_OVERRIDE,
 * EXCHANGE_RATE_CNY_OVERRIDE, or PUT /v1/admin/exchange-rates.
 */
const DEFAULT_VND_PER_USD = 26500;
const DEFAULT_CNY_PER_USD = 7.25;

function positive(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fallbackVndPerUsd(env = process.env) {
  return positive(env.VND_USD_RATE) || DEFAULT_VND_PER_USD;
}

function fallbackCnyPerUsd(env = process.env) {
  return positive(env.CNY_PER_USD) || DEFAULT_CNY_PER_USD;
}

/** Optional env override. Unset means "use the live rate". */
function overrideVndPerUsd(env = process.env) {
  return positive(env.EXCHANGE_RATE_VND_OVERRIDE);
}

function overrideCnyPerUsd(env = process.env) {
  return positive(env.EXCHANGE_RATE_CNY_OVERRIDE);
}

module.exports = {
  DEFAULT_VND_PER_USD,
  DEFAULT_CNY_PER_USD,
  fallbackVndPerUsd,
  fallbackCnyPerUsd,
  overrideVndPerUsd,
  overrideCnyPerUsd,
};

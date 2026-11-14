/**
 * Optional operator overrides for USD conversion.
 *
 * Live rates come from ExchangeRate-API (https://www.exchangerate-api.com)
 * via `src/finance/exchange-rate.js`. There is no built-in VND or CNY figure.
 * Unset means "use the live rate". A missing live rate is an error, not a
 * substitute number.
 *
 * EXCHANGE_RATE_VND_OVERRIDE and EXCHANGE_RATE_CNY_OVERRIDE win over the live
 * rate. PUT /v1/admin/exchange-rates does the same and is stored with the cache.
 */
function positive(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Optional env override. Unset means "use the live rate". */
function overrideVndPerUsd(env = process.env) {
  return positive(env.EXCHANGE_RATE_VND_OVERRIDE);
}

function overrideCnyPerUsd(env = process.env) {
  return positive(env.EXCHANGE_RATE_CNY_OVERRIDE);
}

module.exports = {
  overrideVndPerUsd,
  overrideCnyPerUsd,
};

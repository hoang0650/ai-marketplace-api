const { DEFAULT_VND_PER_USD } = require('./fx');

function num(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Hard ceiling for the seller-chosen affiliate commission (25% of the price after discount). */
const AFFILIATE_MAX_RATE = 0.25;

/**
 * Affiliate settings. Everything except the 25% ceiling is configurable by env.
 *
 * PIT withholding on affiliate income is modelled on the general Vietnamese rule for individual
 * service income, applied to every commission (default threshold 0 VND, i.e. 10% on each
 * commission; set AFFILIATE_PIT_THRESHOLD_VND to apply it only above an amount). It is a configurable rule pending
 * legal review — not a statement of the final tax treatment.
 */
function affiliateConfig(env = process.env) {
  return {
    maxRate: AFFILIATE_MAX_RATE,
    attributionDays: Math.max(1, Math.min(365, Math.floor(num(env.AFFILIATE_ATTRIBUTION_DAYS, 30)))),
    pit: {
      enabled: String(env.AFFILIATE_PIT_ENABLED ?? 'true').toLowerCase() !== 'false',
      rate: Math.max(0, Math.min(1, num(env.AFFILIATE_PIT_RATE, 0.1))),
      thresholdVnd: Math.max(0, num(env.AFFILIATE_PIT_THRESHOLD_VND, 0)),
      vndPerUsd: Math.max(1, num(env.AFFILIATE_VND_PER_USD, DEFAULT_VND_PER_USD)),
    },
  };
}

module.exports = { AFFILIATE_MAX_RATE, affiliateConfig };

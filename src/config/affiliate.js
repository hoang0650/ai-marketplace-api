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
 * PIT on affiliate commissions (Luật Thuế TNCN): the platform withholds 10% when a single
 * commission payment is >= 2,000,000 VND (AFFILIATE_PIT_THRESHOLD_VND), unless the affiliate has an
 * APPROVED commitment form Mẫu 08/CK-TNCN for that year (then 0%). Below the threshold nothing is
 * withheld. Year-end the platform issues PIT withholding certificates (chứng từ khấu trừ thuế TNCN).
 * Pending legal review.
 */
function affiliateConfig(env = process.env) {
  return {
    maxRate: AFFILIATE_MAX_RATE,
    attributionDays: Math.max(1, Math.min(365, Math.floor(num(env.AFFILIATE_ATTRIBUTION_DAYS, 30)))),
    pit: {
      enabled: String(env.AFFILIATE_PIT_ENABLED ?? 'true').toLowerCase() !== 'false',
      rate: Math.max(0, Math.min(1, num(env.AFFILIATE_PIT_RATE, 0.1))),
      thresholdVnd: Math.max(0, num(env.AFFILIATE_PIT_THRESHOLD_VND, 2_000_000)),
      /** An approved Mẫu 08/CK-TNCN commitment exempts the affiliate from withholding. */
      commitmentExempts: String(env.AFFILIATE_PIT_COMMITMENT_EXEMPTS ?? 'true').toLowerCase() !== 'false',
      vndPerUsd: Math.max(1, num(env.AFFILIATE_VND_PER_USD, DEFAULT_VND_PER_USD)),
    },
  };
}

module.exports = { AFFILIATE_MAX_RATE, affiliateConfig };

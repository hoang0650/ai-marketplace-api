const { currentVndPerUsd } = require('../finance/exchange-rate');

function num(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Hard ceiling for the seller-chosen affiliate commission (25% of the price after discount). */
const AFFILIATE_MAX_RATE = 0.25;

/**
 * Affiliate settings. Everything except the 25% ceiling is configurable by env.
 *
 * Affiliate payout + PIT (Luật Thuế TNCN), policy 2026-10 rev. 3:
 * - commissions are credited GROSS (no PIT at credit time);
 * - there is no commercial withdrawal minimum. Any strictly positive eligible balance
 *   (wallet USD, 2 decimal places) can be withdrawn. AFFILIATE_MIN_WITHDRAW_VND is retired:
 *   a value still present in the environment or an old deploy config is ignored and is not deleted;
 * - every affiliate withdrawal has the configured PIT rate withheld (default 10%), unless the
 *   affiliate has an APPROVED Mẫu 08/CK-TNCN for that year (then 0%).
 * Year-end the platform issues PIT withholding certificates (chứng từ khấu trừ thuế TNCN).
 * Pending legal review.
 *
 * `thresholdVnd` used to alias the commercial minimum. It is always 0. It is not the seller
 * annual revenue threshold (TAX_INDIVIDUAL_ANNUAL_THRESHOLD_VND) and it is not a payout floor.
 */
function affiliateConfig(env = process.env) {
  // Read so a persisted deploy value is observed and then discarded. Do not delete the env entry.
  void env.AFFILIATE_MIN_WITHDRAW_VND;
  return {
    maxRate: AFFILIATE_MAX_RATE,
    attributionDays: Math.max(1, Math.min(365, Math.floor(num(env.AFFILIATE_ATTRIBUTION_DAYS, 30)))),
    pit: {
      enabled: String(env.AFFILIATE_PIT_ENABLED ?? 'true').toLowerCase() !== 'false',
      rate: Math.max(0, Math.min(1, num(env.AFFILIATE_PIT_RATE, 0.1))),
      /** Retired commercial minimum. Always 0; never read from AFFILIATE_MIN_WITHDRAW_VND. */
      minWithdrawVnd: 0,
      /** Retired alias of minWithdrawVnd. Always 0. Not a tax threshold and not a hidden floor. */
      thresholdVnd: 0,
      /** An approved Mẫu 08/CK-TNCN commitment exempts the affiliate from withholding. */
      commitmentExempts: String(env.AFFILIATE_PIT_COMMITMENT_EXEMPTS ?? 'true').toLowerCase() !== 'false',
      vndPerUsd: vndRate(env, 'AFFILIATE_VND_PER_USD'),
    },
  };
}

/**
 * A custom env object (tests) may pin the rate. The process environment does not:
 * production uses the live exchange-rate service.
 */
function vndRate(env, key) {
  if (env && env !== process.env) {
    const n = Number(env[key]);
    return Number.isFinite(n) && n > 0 ? Math.max(1, n) : null;
  }
  return currentVndPerUsd();
}

module.exports = { AFFILIATE_MAX_RATE, affiliateConfig };

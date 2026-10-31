const { DEFAULT_VND_PER_USD } = require('./fx');
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
 * Affiliate payout + PIT (Luật Thuế TNCN), policy 2026-10 rev. 2:
 * - commissions are credited GROSS (no PIT at credit time);
 * - an affiliate can withdraw only when the withdrawable affiliate balance is >= 2,000,000 VND and
 *   each withdrawal is >= 2,000,000 VND (AFFILIATE_MIN_WITHDRAW_VND);
 * - every affiliate withdrawal (= one payment of income) has 10% PIT withheld, unless the affiliate has
 *   an APPROVED Mẫu 08/CK-TNCN for that year (then 0%).
 * Year-end the platform issues PIT withholding certificates (chứng từ khấu trừ thuế TNCN).
 * Pending legal review.
 */
function affiliateConfig(env = process.env) {
  const minWithdrawVnd = Math.max(0, num(env.AFFILIATE_MIN_WITHDRAW_VND, 2_000_000));
  return {
    maxRate: AFFILIATE_MAX_RATE,
    attributionDays: Math.max(1, Math.min(365, Math.floor(num(env.AFFILIATE_ATTRIBUTION_DAYS, 30)))),
    pit: {
      enabled: String(env.AFFILIATE_PIT_ENABLED ?? 'true').toLowerCase() !== 'false',
      rate: Math.max(0, Math.min(1, num(env.AFFILIATE_PIT_RATE, 0.1))),
      /** Minimum withdrawable balance AND minimum single withdrawal, in VND. */
      minWithdrawVnd,
      /** Kept for API compatibility: equals minWithdrawVnd (PIT is applied at withdrawal). */
      thresholdVnd: minWithdrawVnd,
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
    return Number.isFinite(n) && n > 0 ? Math.max(1, n) : DEFAULT_VND_PER_USD;
  }
  return currentVndPerUsd();
}

module.exports = { AFFILIATE_MAX_RATE, affiliateConfig };

const { DEFAULT_VND_PER_USD } = require('./fx');

function num(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
const rate = (raw, fallback) => Math.max(0, Math.min(1, num(raw, fallback)));

/**
 * Seller tax policy (2026-10). Rates are env-tunable so ops can follow the rule book without a deploy.
 *
 * - INDIVIDUAL (cá nhân kinh doanh): the platform (which has a payment function) withholds and pays
 *   VAT + PIT on the seller's behalf per Nghị định 117/2025/NĐ-CP, Luật Thuế TNCN and
 *   Thông tư 40/2021/TT-BTC:
 *     services / software / digital products (default for AI Markets): 5% GTGT + 2% TNCN = 7%
 *     physical goods:                                                    1% GTGT + 0.5% TNCN = 1.5%
 *   Base = price after discount (order gross). No withholding while the seller's calendar-year
 *   revenue (including the order) stays at or below the threshold (default 100,000,000 VND/year;
 *   0 disables the exemption). PENDING LEGAL REVIEW: the 2025 amended law may raise the threshold.
 * - HOUSEHOLD_BUSINESS (hộ kinh doanh): 0% - self-declare and issue their own invoices.
 * - COMPANY / organisation: 0% - the platform issues a 10% VAT invoice for its 20% fee.
 */
function taxConfig(env = process.env) {
  return {
    individual: {
      digital: { vat: rate(env.TAX_INDIVIDUAL_DIGITAL_VAT_RATE, 0.05), pit: rate(env.TAX_INDIVIDUAL_DIGITAL_PIT_RATE, 0.02) },
      goods: { vat: rate(env.TAX_INDIVIDUAL_GOODS_VAT_RATE, 0.01), pit: rate(env.TAX_INDIVIDUAL_GOODS_PIT_RATE, 0.005) },
      annualThresholdVnd: Math.max(0, num(env.TAX_INDIVIDUAL_ANNUAL_THRESHOLD_VND, 100_000_000)),
    },
    platformFeeVatRate: rate(env.TAX_PLATFORM_FEE_VAT_RATE, 0.1),
    vndPerUsd: Math.max(1, num(env.TAX_VND_PER_USD, num(env.AFFILIATE_VND_PER_USD, DEFAULT_VND_PER_USD))),
    legalReview: true,
  };
}

module.exports = { taxConfig };

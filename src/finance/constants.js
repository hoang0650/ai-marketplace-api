const PLATFORM_COMMISSION_RATE = 0.2;

/** @deprecated Alias — use PLATFORM_COMMISSION_RATE. Not a tax rate. */
const PLATFORM_FEE_RATE = PLATFORM_COMMISSION_RATE;

/**
 * Tax policy 2026-10: there is no flat seller tax any more. Individual sellers have 7% (5% GTGT +
 * 2% TNCN) withheld on the price after discount for services/software/digital products (1.5% for
 * physical goods); household businesses and companies 0%. See finance/seller-tax-policy.js.
 * @deprecated Kept for callers/display only: the default individual (digital) rate on order gross.
 */
const SELLER_TAX_RATE = 0.07;


function roundMoney(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round((Number(n) || 0) * f) / f;
}

module.exports = {
  PLATFORM_COMMISSION_RATE,
  PLATFORM_FEE_RATE,
  SELLER_TAX_RATE,
  roundMoney,
};

const PLATFORM_COMMISSION_RATE = 0.2;

/** @deprecated Alias — use PLATFORM_COMMISSION_RATE. Not a tax rate. */
const PLATFORM_FEE_RATE = PLATFORM_COMMISSION_RATE;

/**
 * Default withholding on the seller share after platform commission.
 * 10% of the remaining 80% = 8% of order gross.
 */
const SELLER_TAX_RATE = 0.1;


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

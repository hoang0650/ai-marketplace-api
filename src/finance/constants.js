const PLATFORM_COMMISSION_RATE = 0.2;

/** @deprecated Alias — use PLATFORM_COMMISSION_RATE. Not a tax rate. */
const PLATFORM_FEE_RATE = PLATFORM_COMMISSION_RATE;

/**
 * Default withholding on the seller share after platform commission.
 * 10% of the remaining 80% = 8% of order gross.
 */
const SELLER_TAX_RATE = 0.1;

/**
 * Default IAP store commissions (seller-borne, not platform revenue, not tax).
 * Google Play: 15% standard service fee (first $1M / most subscriptions).
 * App Store: 30% standard Apple commission (15% may apply under Apple programs).
 * Actual billed rate follows Google/Apple terms at transaction time; snapshot on the order.
 */
const GOOGLE_PLAY_STORE_FEE_RATE = 0.15;
const APP_STORE_STORE_FEE_RATE = 0.3;

function roundMoney(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round((Number(n) || 0) * f) / f;
}

module.exports = {
  PLATFORM_COMMISSION_RATE,
  PLATFORM_FEE_RATE,
  SELLER_TAX_RATE,
  GOOGLE_PLAY_STORE_FEE_RATE,
  APP_STORE_STORE_FEE_RATE,
  roundMoney,
};

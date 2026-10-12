/**
 * Single default VND↔USD rate used when no env override is set (wallet top-up via GPay,
 * PayPal conversion, payout minimums, display). Keep in sync with the web
 * `src/app/i18n/currency.service.ts`. Env overrides: GPAY_VND_PER_USD / PAYPAL_VND_PER_USD.
 */
const DEFAULT_VND_PER_USD = 26500;

module.exports = { DEFAULT_VND_PER_USD };

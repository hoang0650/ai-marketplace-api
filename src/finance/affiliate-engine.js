const { roundMoney } = require('./constants');
const { AFFILIATE_MAX_RATE, affiliateConfig } = require('../config/affiliate');

/**
 * Validate a seller-entered affiliate rate. Accepts a fraction (0–0.25).
 * Returns { ok, rate } or { ok: false, code, message }. `null`/'' means "inherit store default".
 */
function parseAffiliateRate(raw, { allowNull = false } = {}) {
  if (raw === null || raw === undefined || raw === '') {
    return allowNull ? { ok: true, rate: null } : { ok: true, rate: 0 };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > AFFILIATE_MAX_RATE + 1e-9) {
    return {
      ok: false,
      code: 'AFFILIATE_RATE_INVALID',
      message: `Affiliate commission must be between 0% and ${AFFILIATE_MAX_RATE * 100}% of the order value.`,
    };
  }
  return { ok: true, rate: Math.round(n * 10000) / 10000 };
}

/** Product override wins; `null` inherits the store default; anything invalid counts as 0. */
function effectiveAffiliateRate(product, sellerProfile) {
  const own = product?.affiliateRate;
  const raw = own === null || own === undefined ? sellerProfile?.affiliateDefaultRate : own;
  const parsed = parseAffiliateRate(raw);
  return parsed.ok ? parsed.rate || 0 : 0;
}

function toVnd(amount, currency, cfg) {
  return String(currency || 'USD').toUpperCase() === 'VND' ? amount : amount * cfg.pit.vndPerUsd;
}

/**
 * Commission on the price after discount (order gross), borne by the seller.
 * PIT is withheld from the affiliate (not the seller) on every commission above the threshold (default 0, so every commission).
 */
function calculateAffiliateCommission({ baseAmount, rate, currency = 'USD', digits = 2, config } = {}) {
  const cfg = config || affiliateConfig();
  const r = parseAffiliateRate(rate);
  const appliedRate = r.ok ? r.rate || 0 : 0;
  const base = roundMoney(Math.max(0, Number(baseAmount) || 0), digits);
  const amount = roundMoney(base * appliedRate, digits);
  const pitApplies = cfg.pit.enabled && amount > 0 && toVnd(amount, currency, cfg) > cfg.pit.thresholdVnd;
  const pitRate = pitApplies ? cfg.pit.rate : 0;
  const pitAmount = roundMoney(amount * pitRate, digits);
  return {
    rate: appliedRate,
    baseAmount: base,
    amount,
    pitRate,
    pitAmount,
    netAmount: roundMoney(amount - pitAmount, digits),
    pitRule: pitApplies ? 'VN_PIT_SERVICE_INCOME_10PCT_OVER_2M' : '',
  };
}

module.exports = { parseAffiliateRate, effectiveAffiliateRate, calculateAffiliateCommission };

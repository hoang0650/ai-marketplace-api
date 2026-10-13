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
 * Credited GROSS to the affiliate: PIT is withheld when the affiliate withdraws
 * (see quoteAffiliateWithdrawal), not per commission.
 */
function calculateAffiliateCommission({ baseAmount, rate, currency = 'USD', digits = 2, config } = {}) {
  const cfg = config || affiliateConfig();
  const r = parseAffiliateRate(rate);
  const appliedRate = r.ok ? r.rate || 0 : 0;
  const base = roundMoney(Math.max(0, Number(baseAmount) || 0), digits);
  const amount = roundMoney(base * appliedRate, digits);
  return {
    rate: appliedRate,
    baseAmount: base,
    amount,
    pitRate: 0,
    pitAmount: 0,
    netAmount: amount,
    pitRule: amount > 0 && cfg.pit.enabled ? 'PIT_AT_WITHDRAWAL' : '',
    /** Commission in VND at credit time (informational). */
    amountVnd: roundMoney(toVnd(amount, currency, cfg), 0),
  };
}

/**
 * Affiliate withdrawal: allowed only when the withdrawable affiliate balance AND the requested amount
 * are >= minWithdrawVnd (2,000,000 VND). Each withdrawal has 10% PIT withheld unless an approved
 * Mẫu 08/CK-TNCN covers the year. Amounts are in `currency` (wallet currency, USD by default).
 * Example (VND): withdraw 2,500,000 -> PIT 250,000, receive 2,250,000.
 */
function quoteAffiliateWithdrawal({ amount, available, currency = 'USD', digits = 2, config, pitCommitmentApproved = false } = {}) {
  const cfg = config || affiliateConfig();
  const gross = roundMoney(Math.max(0, Number(amount) || 0), digits);
  const avail = roundMoney(Math.max(0, Number(available) || 0), digits);
  const minVnd = cfg.pit.minWithdrawVnd;
  const amountVnd = roundMoney(toVnd(gross, currency, cfg), 0);
  const availableVnd = roundMoney(toVnd(avail, currency, cfg), 0);
  const base = { gross, available: avail, amountVnd, availableVnd, minWithdrawVnd: minVnd, currency };
  if (availableVnd < minVnd) {
    return { ...base, ok: false, code: 'AFFILIATE_MIN_BALANCE', message: `Affiliate balance must be at least ${minVnd.toLocaleString('vi-VN')} VND to withdraw.` };
  }
  if (amountVnd < minVnd) {
    return { ...base, ok: false, code: 'AFFILIATE_MIN_WITHDRAWAL', message: `Minimum affiliate withdrawal is ${minVnd.toLocaleString('vi-VN')} VND.` };
  }
  if (gross > avail + 1e-9) {
    return { ...base, ok: false, code: 'AFFILIATE_INSUFFICIENT', message: 'Amount exceeds the withdrawable affiliate balance.' };
  }
  const exempt = !!pitCommitmentApproved && cfg.pit.commitmentExempts !== false;
  const pitRate = cfg.pit.enabled && !exempt ? cfg.pit.rate : 0;
  const pitAmount = roundMoney(gross * pitRate, digits);
  return {
    ...base,
    ok: true,
    pitRate,
    pitAmount,
    pitAmountVnd: roundMoney(amountVnd * pitRate, 0),
    net: roundMoney(gross - pitAmount, digits),
    pitRule: !cfg.pit.enabled ? '' : exempt ? 'EXEMPT_CAM_KET_08_CK_TNCN' : 'VN_PIT_10PCT_AFFILIATE_WITHDRAWAL',
    pitCommitmentApplied: exempt && cfg.pit.enabled,
  };
}

module.exports = { parseAffiliateRate, effectiveAffiliateRate, calculateAffiliateCommission, quoteAffiliateWithdrawal };

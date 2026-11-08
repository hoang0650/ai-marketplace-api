const { roundMoney } = require('./constants');
const { AFFILIATE_MAX_RATE, affiliateConfig } = require('../config/affiliate');
const { isAffiliateCode } = require('../utils/affiliate-code');

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

function currencyScale(currency, digits) {
  if (String(currency || 'USD').toUpperCase() === 'VND') return 0;
  const d = Number(digits);
  return Number.isInteger(d) && d >= 0 && d <= 8 ? d : 2;
}

/** Finite number, including numeric strings. Anything else is NaN. */
function readAmount(raw) {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(s)) return NaN;
    return Number(s);
  }
  return NaN;
}

function onScale(n, digits) {
  if (!Number.isFinite(n)) return false;
  const factor = 10 ** digits;
  return Math.abs(n * factor - Math.round(n * factor)) <= 1e-6;
}

/**
 * Identity (eKYC, or admin) plus a positive eligible balance at wallet precision.
 * `available` is already net of the 48h hold and open disputes. A balance that
 * rounds to 0.00 USD is not withdrawable; that is currency precision, not a minimum.
 */
/**
 * Affiliate is a capability, not a separate account role and not a downline.
 * A new code is not minted here: electronic identity is not implemented, and a
 * document review or a manual tax-code review does not stand in for it.
 * An existing code is left in place.
 */
function affiliateParticipation(user) {
  const kycStatus = String(user?.kyc?.status || 'none');
  const hasCode = isAffiliateCode(user?.affiliateCode);
  return {
    capability: 'affiliate',
    separateRole: false,
    multiLevel: false,
    depositToJoin: false,
    recruitment: false,
    kycStatus,
    electronicIdentityStatus: 'not_implemented',
    electronicIdentitySatisfied: false,
    manualTaxReviewGrantsAffiliateEligibility: false,
    codeIssuance: 'closed_pending_electronic_identity',
    code: hasCode && kycStatus === 'verified' ? String(user.affiliateCode).trim().toUpperCase() : null,
    linkReady: hasCode && kycStatus === 'verified',
    minWithdrawVnd: 0,
    taxDetermination: 'unresolved',
  };
}

function affiliateCanWithdraw({ available, identityVerified = false } = {}) {
  const n = Number(available);
  const spendable = Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  return !!identityVerified && spendable > 0;
}

/**
 * Affiliate withdrawal. No commercial minimum: any strictly positive eligible amount
 * at the wallet's precision. The HTTP contract is USD with 2 decimal places
 * (`POST /v1/wallet/withdraw`, persona `affiliate`). A positive amount that rounds to
 * 0.00 USD is rejected as precision, not as a payout floor.
 *
 * Stored `minWithdrawVnd` / `thresholdVnd` (including AFFILIATE_MIN_WITHDRAW_VND) are
 * ignored and are not deleted from the config object or the environment.
 * PIT uses the configured rate (default 10%) unless an approved Mẫu 08/CK-TNCN applies.
 * Example (VND): withdraw 2,500,000 -> PIT 250,000, receive 2,250,000.
 */
function quoteAffiliateWithdrawal({ amount, available, currency = 'USD', digits = 2, config, pitCommitmentApproved = false } = {}) {
  const cfg = config || affiliateConfig();
  const currencyCode = String(currency || 'USD').toUpperCase();
  const scale = currencyScale(currencyCode, digits);
  const raw = readAmount(amount);
  const availNum = Number(available);
  const avail = Number.isFinite(availNum) ? roundMoney(Math.max(0, availNum), scale) : null;
  const base = {
    gross: Number.isFinite(raw) ? roundMoney(Math.max(0, raw), scale) : null,
    available: avail,
    amountVnd: null,
    availableVnd: null,
    minWithdrawVnd: 0,
    currency: currencyCode,
  };
  const fail = (code, message, extra = {}) => ({ ...base, ...extra, ok: false, code, message, minWithdrawVnd: 0 });

  if (!Number.isFinite(raw)) {
    return fail('AFFILIATE_AMOUNT_INVALID', 'Affiliate withdrawal amount must be a finite number greater than 0.');
  }
  if (!(raw > 0)) {
    return fail('AFFILIATE_AMOUNT_INVALID', 'Affiliate withdrawal amount must be greater than 0.');
  }
  const gross = roundMoney(raw, scale);
  if (!onScale(raw, scale) || !(gross > 0)) {
    const message = currencyCode === 'VND'
      ? (gross > 0
        ? 'Affiliate withdrawal must be a whole number of VND.'
        : 'Affiliate withdrawal amount rounds to 0 VND. This is below currency precision, not a minimum payout.')
      : (gross > 0
        ? 'Affiliate withdrawal amount must be in USD with at most 2 decimal places.'
        : 'Affiliate withdrawal amount rounds to 0.00 USD. This is below wallet precision, not a minimum payout.');
    return fail('AFFILIATE_AMOUNT_PRECISION', message, { gross: gross > 0 ? gross : 0 });
  }
  if (avail === null || gross > avail) {
    return fail('AFFILIATE_INSUFFICIENT', 'Amount exceeds the withdrawable affiliate balance.', { gross, available: avail });
  }

  const amountVnd = roundMoney(toVnd(gross, currencyCode, cfg), 0);
  const availableVnd = roundMoney(toVnd(avail, currencyCode, cfg), 0);
  const exempt = !!pitCommitmentApproved && cfg.pit.commitmentExempts !== false;
  const pitRate = cfg.pit.enabled && !exempt ? cfg.pit.rate : 0;
  const pitAmount = roundMoney(gross * pitRate, scale);
  return {
    ...base,
    gross,
    available: avail,
    amountVnd: Number.isFinite(amountVnd) ? amountVnd : null,
    availableVnd: Number.isFinite(availableVnd) ? availableVnd : null,
    ok: true,
    pitRate,
    pitAmount,
    pitAmountVnd: Number.isFinite(amountVnd) ? roundMoney(amountVnd * pitRate, 0) : 0,
    net: roundMoney(gross - pitAmount, scale),
    pitRule: !cfg.pit.enabled ? '' : exempt ? 'EXEMPT_CAM_KET_08_CK_TNCN' : 'VN_PIT_10PCT_AFFILIATE_WITHDRAWAL',
    pitCommitmentApplied: exempt && cfg.pit.enabled,
    legalDetermination: 'unresolved',
    statutoryRuleApplied: false,
    article50Paragraph2Applied: false,
  };
}

module.exports = {
  parseAffiliateRate,
  effectiveAffiliateRate,
  calculateAffiliateCommission,
  quoteAffiliateWithdrawal,
  affiliateCanWithdraw,
  affiliateParticipation,
};

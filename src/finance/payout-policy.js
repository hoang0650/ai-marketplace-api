const config = require('../config/env');
const TalentProfile = require('../models/TalentProfile');
const SellerProfile = require('../models/SellerProfile');
const { DEFAULT_VND_PER_USD } = require('../config/fx');

/**
 * Withdrawal policy per marketplace persona.
 *
 * - buyer        : may withdraw the wallet balance after eKYC (ID/passport); no fee
 * - seller       : product/creator earnings — 20% platform commission + tax by seller type
 *                  (individual 7% digital / 1.5% goods withheld; household business & company 0%)
 * - talent       : talent profile earnings — same as seller
 * - freelancer   : accepted job applicant — same as seller
 * - employer / HR: job poster — 1% fee, minimum balance before withdrawal
 * - admin        : bypass (ops)
 *
 * Seller-side earnings are credited already net of commission+tax at sale time
 * (settlement snapshot); the rates below are the contractual policy surfaced on
 * withdraw and applied to balances that were credited gross (e.g. manual
 * adjustments). Kept env-tunable so ops can match the current rule book.
 */

const PERSONAS = ['buyer', 'seller', 'talent', 'freelancer', 'employer'];
const SELLER_LIKE = new Set(['seller', 'talent', 'freelancer']);

function rateFromEnv(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

const SELLER_PLATFORM_FEE_RATE = rateFromEnv('WITHDRAW_SELLER_PLATFORM_FEE_RATE', 0.2);
const { sellerTaxRateFor } = require('./seller-tax-policy');

/** Explicit env override (legacy); unset = rate follows the seller type (tax policy 2026-10). */
const SELLER_TAX_RATE_OVERRIDE = rateFromEnv('WITHDRAW_SELLER_TAX_RATE', null);
/** Default individual (digital) rate - informational. */
const SELLER_TAX_RATE = SELLER_TAX_RATE_OVERRIDE ?? sellerTaxRateFor('INDIVIDUAL', 'AI_API').total;
const EMPLOYER_FEE_RATE = rateFromEnv('WITHDRAW_EMPLOYER_FEE_RATE', 0.01);
const EMPLOYER_MIN_VND = Math.max(0, Number(process.env.WITHDRAW_EMPLOYER_MIN_VND || 2_000_000) || 2_000_000);

/**
 * Seller earnings are already credited net of the 20% commission + type-based tax at
 * order settlement (`settleSale`), so re-charging on withdraw would double-tax.
 * Default false = rates are informational on the withdraw screen. Flip to true
 * only if balances are credited gross (e.g. manual admin top-ups).
 */
const SELLER_CHARGE_AT_WITHDRAW = String(process.env.WITHDRAW_SELLER_CHARGE_AT_WITHDRAW || '').toLowerCase() === 'true';

const VND_PER_USD = Math.max(1, Number(process.env.PAYPAL_VND_PER_USD || config.paypalVndPerUsd || DEFAULT_VND_PER_USD) || DEFAULT_VND_PER_USD);

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function vndToUsd(vnd) {
  return roundMoney(Number(vnd || 0) / VND_PER_USD);
}

function sellerTaxRate(sellerType) {
  if (SELLER_TAX_RATE_OVERRIDE !== null) return SELLER_TAX_RATE_OVERRIDE;
  return sellerType ? sellerTaxRateFor(sellerType, 'AI_API').total : SELLER_TAX_RATE;
}

/** Fee/tax/minimum policy for a persona (admin handled by callers). */
function policyFor(persona, { sellerType } = {}) {
  if (persona === 'employer') {
    const minUsd = vndToUsd(EMPLOYER_MIN_VND);
    return {
      persona,
      canWithdraw: true,
      platformFeeRate: EMPLOYER_FEE_RATE,
      taxRate: 0,
      totalFeeRate: EMPLOYER_FEE_RATE,
      chargeAtWithdraw: true,
      minAmount: minUsd,
      minAmountCurrency: 'USD',
      minAmountVnd: EMPLOYER_MIN_VND,
      holdHours: 0,
      requiresNoDispute: false,
    };
  }
  if (SELLER_LIKE.has(persona)) {
    return {
      persona,
      canWithdraw: true,
      platformFeeRate: SELLER_PLATFORM_FEE_RATE,
      taxRate: sellerTaxRate(sellerType),
      totalFeeRate: roundMoney(SELLER_PLATFORM_FEE_RATE + sellerTaxRate(sellerType)),
      sellerType: sellerType || null,
      chargeAtWithdraw: SELLER_CHARGE_AT_WITHDRAW,
      minAmount: 0,
      minAmountCurrency: 'USD',
      minAmountVnd: 0,
      holdHours: Number(process.env.PAYOUT_HOLD_HOURS || 48) || 48,
      requiresNoDispute: true,
    };
  }
  // Quy chế 2.1, khoản 3 Mục XI: buyers may withdraw their wallet balance once eKYC
  // (CCCD/passport) is verified. No platform fee/tax applies to a buyer's own top-ups.
  return {
    persona: 'buyer',
    canWithdraw: true,
    platformFeeRate: 0,
    taxRate: 0,
    totalFeeRate: 0,
    chargeAtWithdraw: false,
    minAmount: 0,
    minAmountCurrency: 'USD',
    minAmountVnd: 0,
    holdHours: 0,
    requiresNoDispute: false,
  };
}

const PERSONA_PRIORITY = ['seller', 'talent', 'freelancer', 'employer'];

function has(obj, key) {
  return obj && Object.prototype.hasOwnProperty.call(obj, key);
}

/** Eligible personas for a user (role first, then profile evidence). */
async function detectPersonas(user) {
  if (!user) return ['buyer'];
  if (user.role === 'admin') return ['admin'];
  const uid = user._id || user.id;
  const role = require('../utils/roles').normalizeRole(user.role);
  // Work is shut down: employer/freelancer personas are no longer offered. Their wallet
  // balance (one wallet per user) is withdrawn under the seller/talent or buyer policy.
  const [seller, talent] = await Promise.all([
    role === 'seller' ? Promise.resolve(true) : SellerProfile.exists({ user: uid }),
    role === 'talent' ? Promise.resolve(true) : TalentProfile.exists({ user: uid }),
  ]);
  const found = [];
  if (seller) found.push('seller');
  if (talent) found.push('talent');
  found.push('buyer');
  return found;
}

function pickPrimary(personas) {
  for (const p of PERSONA_PRIORITY) {
    if (personas.includes(p)) return p;
  }
  return 'buyer';
}

/**
 * Resolve persona for a withdrawal.
 * `requested` must be one of the user's eligible personas, otherwise primary wins.
 */
async function resolvePayoutPersona(user, requested) {
  const personas = await detectPersonas(user);
  if (user && user.role === 'admin') {
    return { personas, persona: 'admin', policy: { ...policyFor('employer'), persona: 'admin', platformFeeRate: 0, taxRate: 0, totalFeeRate: 0, minAmount: 0, minAmountVnd: 0 } };
  }
  const wanted = String(requested || '').trim();
  // Sellers share one wallet ledger with their buyer persona; never let 'buyer' be used
  // to bypass the seller verification gate on seller earnings.
  const sellerLike = personas.some((p) => SELLER_LIKE.has(p));
  const allowed = wanted && personas.includes(wanted) && !(wanted === 'buyer' && sellerLike);
  const persona = allowed ? wanted : pickPrimary(personas);
  let sellerType;
  if (SELLER_LIKE.has(persona) && user) {
    const sp = await SellerProfile.findOne({ user: user._id || user.id }).select('sellerType').lean().catch(() => null);
    sellerType = sp?.sellerType ? require('./seller-types').normalizeSellerType(sp.sellerType) : undefined;
  }
  return { personas, persona, policy: policyFor(persona, { sellerType }) };
}

/** Apply the persona fee/tax to a gross withdrawal amount. */
function quoteWithdrawal(grossAmount, policy) {
  const gross = roundMoney(grossAmount);
  const chargeAtWithdraw = policy?.canWithdraw === false ? false : policy?.chargeAtWithdraw !== false;
  const platformFee = chargeAtWithdraw ? roundMoney(gross * Number(policy?.platformFeeRate || 0)) : 0;
  const tax = chargeAtWithdraw ? roundMoney(gross * Number(policy?.taxRate || 0)) : 0;
  const net = roundMoney(Math.max(0, gross - platformFee - tax));
  return {
    gross,
    platformFee,
    tax,
    net,
    totalFee: roundMoney(platformFee + tax),
    chargeAtWithdraw,
  };
}

function mapPolicy(policy) {
  return {
    persona: policy.persona,
    canWithdraw: policy.canWithdraw,
    platformFeeRate: policy.platformFeeRate,
    taxRate: policy.taxRate,
    totalFeeRate: policy.totalFeeRate,
    chargeAtWithdraw: policy.chargeAtWithdraw !== false,
    minAmount: policy.minAmount,
    minAmountCurrency: policy.minAmountCurrency,
    minAmountVnd: policy.minAmountVnd,
    holdHours: policy.holdHours,
    requiresNoDispute: policy.requiresNoDispute,
    requiresKyc: policy.persona !== 'admin',
    sellerType: policy.sellerType || null,
  };
}

function personaLabel(persona) {
  const map = {
    buyer: 'Buyer',
    seller: 'Seller',
    talent: 'Talent',
    freelancer: 'Freelancer',
    employer: 'Employer / HR',
    admin: 'Admin',
  };
  return has(map, persona) ? map[persona] : persona;
}

module.exports = {
  PERSONAS,
  SELLER_LIKE,
  SELLER_PLATFORM_FEE_RATE,
  SELLER_TAX_RATE,
  EMPLOYER_FEE_RATE,
  EMPLOYER_MIN_VND,
  VND_PER_USD,
  vndToUsd,
  policyFor,
  detectPersonas,
  pickPrimary,
  resolvePayoutPersona,
  quoteWithdrawal,
  mapPolicy,
  personaLabel,
  roundMoney,
};

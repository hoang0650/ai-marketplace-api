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
 * - affiliate    : affiliate commissions — withdrawable only when the affiliate balance and the
 *                  withdrawal are >= 2,000,000 VND; 10% PIT withheld per withdrawal, 0% with an
 *                  approved Mẫu 08/CK-TNCN
 * - employer / HR: job poster — 1% fee, minimum balance before withdrawal
 * - admin        : bypass (ops)
 *
 * Seller-side earnings are credited already net of commission+tax at sale time
 * (settlement snapshot); the rates below are the contractual policy surfaced on
 * withdraw and applied to balances that were credited gross (e.g. manual
 * adjustments). Kept env-tunable so ops can match the current rule book.
 */

const PERSONAS = ['buyer', 'seller', 'talent', 'freelancer', 'employer', 'affiliate'];
const SELLER_LIKE = new Set(['seller', 'talent', 'freelancer']);

function rateFromEnv(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

const SELLER_PLATFORM_FEE_RATE = rateFromEnv('WITHDRAW_SELLER_PLATFORM_FEE_RATE', 0.2);
const { sellerTaxRateFor, productTaxKind } = require('./seller-tax-policy');

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

/**
 * Tax shown on the withdraw screen for a seller, from the seller's actual tax profile/type and the
 * kinds of products they sell (Quy chế: individual 7% digital / 1.5% physical goods; household
 * business & company 0%). Never assumes 7% for an undeclared seller type.
 *   mode 'override'  : legacy env WITHDRAW_SELLER_TAX_RATE
 *   mode 'unknown'   : seller type not declared -> taxRate null, prompt to complete the tax profile
 *   mode 'none'      : seller type is not withheld (household business, company, ...) -> 0%
 *   mode 'single'    : one product kind -> that rate
 *   mode 'per_order' : digital + physical products -> rate per order (breakdown), taxRate null
 */
function sellerTaxSummary({ sellerType, sellerTypeKnown, productKinds } = {}) {
  const fee = SELLER_PLATFORM_FEE_RATE;
  const rate6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
  const row = (kind, rate) => ({ kind, rate, totalFeeRate: rate6(fee + rate) });
  if (SELLER_TAX_RATE_OVERRIDE !== null) {
    return { mode: 'override', taxRate: SELLER_TAX_RATE_OVERRIDE, breakdown: [row('ALL', SELLER_TAX_RATE_OVERRIDE)] };
  }
  const known = sellerTypeKnown === undefined ? !!sellerType : !!sellerTypeKnown;
  if (!known) return { mode: 'unknown', taxRate: null, breakdown: [] };
  const kinds = [...new Set((productKinds || []).map((k) => (String(k).toUpperCase() === 'GOODS' ? 'GOODS' : 'DIGITAL')))].sort();
  const list = kinds.length ? kinds : ['DIGITAL'];
  const rateOf = (kind) => sellerTaxRateFor(sellerType, kind === 'GOODS' ? 'PHYSICAL_GOODS' : 'AI_API').total;
  const breakdown = list.map((k) => row(k, rateOf(k)));
  if (breakdown.every((b) => b.rate === 0)) return { mode: 'none', taxRate: 0, breakdown: [row('ALL', 0)] };
  if (breakdown.length === 1) return { mode: 'single', taxRate: breakdown[0].rate, breakdown };
  return { mode: 'per_order', taxRate: null, breakdown };
}

/** Fee/tax/minimum policy for a persona (admin handled by callers). */
function policyFor(persona, { sellerType, sellerTypeKnown, productKinds, pitCommitmentApproved = false } = {}) {
  if (persona === 'affiliate') {
    const { affiliateConfig } = require('../config/affiliate');
    const cfg = affiliateConfig();
    const exempt = !!pitCommitmentApproved && cfg.pit.commitmentExempts !== false;
    const taxRate = cfg.pit.enabled && !exempt ? cfg.pit.rate : 0;
    return {
      persona,
      canWithdraw: true,
      platformFeeRate: 0,
      taxRate,
      totalFeeRate: taxRate,
      chargeAtWithdraw: true,
      minAmount: roundMoney(cfg.pit.minWithdrawVnd / cfg.pit.vndPerUsd),
      minAmountCurrency: 'USD',
      minAmountVnd: cfg.pit.minWithdrawVnd,
      holdHours: Number(process.env.PAYOUT_HOLD_HOURS || 48) || 48,
      requiresNoDispute: true,
      pitRule: !cfg.pit.enabled ? '' : exempt ? 'EXEMPT_CAM_KET_08_CK_TNCN' : 'VN_PIT_10PCT_AFFILIATE_WITHDRAWAL',
      pitCommitmentApproved: exempt,
    };
  }
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
    const tax = sellerTaxSummary({ sellerType, sellerTypeKnown, productKinds });
    return {
      persona,
      canWithdraw: true,
      platformFeeRate: SELLER_PLATFORM_FEE_RATE,
      // Display: null when it depends on the order (mixed kinds) or the seller type is undeclared.
      taxRate: tax.taxRate,
      totalFeeRate: tax.taxRate === null ? null : Math.round((SELLER_PLATFORM_FEE_RATE + tax.taxRate) * 1e6) / 1e6,
      taxMode: tax.mode,
      taxBreakdown: tax.breakdown,
      taxProfileIncomplete: tax.mode === 'unknown',
      /** Rate used only if WITHDRAW_SELLER_CHARGE_AT_WITHDRAW forces charging (unchanged behaviour). */
      quoteTaxRate: sellerTaxRate(sellerType),
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
  const AffiliateCommission = require('../models/AffiliateCommission');
  const [seller, talent, affiliate] = await Promise.all([
    role === 'seller' ? Promise.resolve(true) : SellerProfile.exists({ user: uid }),
    role === 'talent' ? Promise.resolve(true) : TalentProfile.exists({ user: uid }),
    AffiliateCommission.exists({ affiliate: uid }).catch(() => null),
  ]);
  const found = [];
  if (seller) found.push('seller');
  if (talent) found.push('talent');
  if (affiliate) found.push('affiliate');
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
  let sellerTypeKnown = false;
  let productKinds = [];
  if (SELLER_LIKE.has(persona) && user) {
    const uid = user._id || user.id;
    const { currentSellerTaxProfile } = require('./settlement-service');
    const { taxCategoryFromProduct } = require('./tax-category');
    const Product = require('../models/Product');
    const [taxProfile, sp, products] = await Promise.all([
      currentSellerTaxProfile(uid).catch(() => null),
      SellerProfile.findOne({ user: uid }).select('sellerType sellerTypeDeclaredAt').lean().catch(() => null),
      Product.find({ creator: uid }).select('taxCategory productKind productType category').limit(500).lean().catch(() => []),
    ]);
    const raw = taxProfile?.sellerType || sp?.sellerType;
    sellerType = raw ? require('./seller-types').normalizeSellerType(raw) : undefined;
    // Known = a tax profile exists, the type was explicitly declared, or a non-default type is stored.
    sellerTypeKnown = !!(taxProfile?.sellerType || sp?.sellerTypeDeclaredAt || (sp?.sellerType && !/^individual$/i.test(sp.sellerType)));
    productKinds = (products || []).map((p) => productTaxKind(taxCategoryFromProduct(p)));
  }
  let pitCommitmentApproved = false;
  if (persona === 'affiliate' && user) {
    const User = require('../models/User');
    const u = await User.findById(user._id || user.id).select('pitCommitment').lean().catch(() => null);
    pitCommitmentApproved = require('../utils/pit-commitment').isPitCommitmentApproved(u, new Date());
  }
  return { personas, persona, policy: policyFor(persona, { sellerType, sellerTypeKnown, productKinds, pitCommitmentApproved }) };
}

/** Apply the persona fee/tax to a gross withdrawal amount. */
function quoteWithdrawal(grossAmount, policy) {
  const gross = roundMoney(grossAmount);
  const chargeAtWithdraw = policy?.canWithdraw === false ? false : policy?.chargeAtWithdraw !== false;
  const platformFee = chargeAtWithdraw ? roundMoney(gross * Number(policy?.platformFeeRate || 0)) : 0;
  const taxRate = policy?.quoteTaxRate ?? policy?.taxRate;
  const tax = chargeAtWithdraw ? roundMoney(gross * Number(taxRate || 0)) : 0;
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
    ...(policy.taxMode ? { taxMode: policy.taxMode, taxBreakdown: policy.taxBreakdown || [], taxProfileIncomplete: !!policy.taxProfileIncomplete } : {}),
    ...(policy.persona === 'affiliate' ? { pitRule: policy.pitRule, pitCommitmentApproved: !!policy.pitCommitmentApproved } : {}),
  };
}

function personaLabel(persona) {
  const map = {
    buyer: 'Buyer',
    seller: 'Seller',
    talent: 'Talent',
    freelancer: 'Freelancer',
    employer: 'Employer / HR',
    affiliate: 'Affiliate',
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
  sellerTaxSummary,
  detectPersonas,
  pickPrimary,
  resolvePayoutPersona,
  quoteWithdrawal,
  mapPolicy,
  personaLabel,
  roundMoney,
};

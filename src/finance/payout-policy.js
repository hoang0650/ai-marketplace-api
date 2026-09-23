const config = require('../config/env');
const JobPosting = require('../models/JobPosting');
const JobApplication = require('../models/JobApplication');
const TalentProfile = require('../models/TalentProfile');
const SellerProfile = require('../models/SellerProfile');

/**
 * Withdrawal policy per marketplace persona.
 *
 * - buyer        : withdrawal not available (wallet is spend-only)
 * - seller       : product/creator earnings — 20% platform commission + 8% tax
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
const SELLER_TAX_RATE = rateFromEnv('WITHDRAW_SELLER_TAX_RATE', 0.08);
const EMPLOYER_FEE_RATE = rateFromEnv('WITHDRAW_EMPLOYER_FEE_RATE', 0.01);
const EMPLOYER_MIN_VND = Math.max(0, Number(process.env.WITHDRAW_EMPLOYER_MIN_VND || 2_000_000) || 2_000_000);

/**
 * Seller earnings are already credited net of the 20% commission + 8% tax at
 * order settlement (`settleSale`), so re-charging on withdraw would double-tax.
 * Default false = rates are informational on the withdraw screen. Flip to true
 * only if balances are credited gross (e.g. manual admin top-ups).
 */
const SELLER_CHARGE_AT_WITHDRAW = String(process.env.WITHDRAW_SELLER_CHARGE_AT_WITHDRAW || '').toLowerCase() === 'true';

const VND_PER_USD = Math.max(1, Number(process.env.PAYPAL_VND_PER_USD || config.paypalVndPerUsd || 26000) || 26000);

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function vndToUsd(vnd) {
  return roundMoney(Number(vnd || 0) / VND_PER_USD);
}

/** Fee/tax/minimum policy for a persona (admin handled by callers). */
function policyFor(persona) {
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
      taxRate: SELLER_TAX_RATE,
      totalFeeRate: roundMoney(SELLER_PLATFORM_FEE_RATE + SELLER_TAX_RATE),
      chargeAtWithdraw: SELLER_CHARGE_AT_WITHDRAW,
      minAmount: 0,
      minAmountCurrency: 'USD',
      minAmountVnd: 0,
      holdHours: Number(process.env.PAYOUT_HOLD_HOURS || 48) || 48,
      requiresNoDispute: true,
    };
  }
  return {
    persona: 'buyer',
    canWithdraw: false,
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
  const [seller, talent, employer, freelancer] = await Promise.all([
    role === 'seller' ? Promise.resolve(true) : SellerProfile.exists({ user: uid }),
    role === 'talent' ? Promise.resolve(true) : TalentProfile.exists({ user: uid }),
    role === 'employer' ? Promise.resolve(true) : JobPosting.exists({ postedBy: uid }),
    role === 'freelancer' ? Promise.resolve(true) : JobApplication.exists({ applicant: uid, status: 'accepted' }),
  ]);
  const found = [];
  if (seller) found.push('seller');
  if (talent) found.push('talent');
  if (freelancer) found.push('freelancer');
  if (employer) found.push('employer');
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
  const persona = wanted && personas.includes(wanted) ? wanted : pickPrimary(personas);
  return { personas, persona, policy: policyFor(persona) };
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

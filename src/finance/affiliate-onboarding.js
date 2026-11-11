'use strict';

const { SIGNUP_ROLES, ROLE, isSignupRole, normalizeRole } = require('../utils/roles');
const { isValidTaxCode, decideManualTaxReview } = require('../utils/seller-compliance');

/** Current affiliate operating-rules text the server will record. The client does not name the version. */
const AFFILIATE_POLICY_VERSION = 'quy-che-affiliate-2026-10';

function resolveSignupRole(body = {}) {
  const requested = String(body.role || '').trim().toLowerCase();
  const role = !requested && body.asCreator ? ROLE.SELLER : requested || ROLE.BUYER;
  if (!isSignupRole(role)) {
    return {
      ok: false,
      code: 'INVALID_ROLE',
      message: `Invalid role. Choose one of: ${SIGNUP_ROLES.join(', ')}`,
      roles: [...SIGNUP_ROLES],
    };
  }
  return { ok: true, role: normalizeRole(role) };
}

function emailIsVerified(user = {}) {
  if (user.emailVerified === true) return true;
  if (user.emailVerified === false) return false;
  return user.authProvider === 'google';
}

/**
 * Fields written at sign-up. An affiliate account records intent only.
 * No affiliate code is minted here.
 */
function signupAffiliateFields(role, { emailVerified = false, acceptAffiliatePolicy = false } = {}) {
  const affiliate = normalizeRole(role) === ROLE.AFFILIATE;
  const accepted = affiliate && acceptAffiliatePolicy === true;
  return {
    emailVerified: !!emailVerified,
    affiliateCode: '',
    affiliateOnboarding: {
      intent: affiliate,
      policyAccepted: accepted,
      policyVersion: accepted ? AFFILIATE_POLICY_VERSION : '',
      policyAcceptedAt: accepted ? new Date() : null,
      taxCode: '',
      taxReview: {
        status: 'none',
        lookupAttested: false,
        reason: '',
        source: 'manual_public_lookup',
        grantsElectronicIdentity: false,
        grantsAffiliateEligibility: false,
      },
    },
  };
}

function declareAffiliateTax(user, { taxCode, acceptAffiliatePolicy } = {}) {
  if (normalizeRole(user?.role) !== ROLE.AFFILIATE) {
    return { ok: false, code: 'AFFILIATE_ROLE_REQUIRED', message: 'Only an affiliate account can complete this onboarding.' };
  }
  const next = {
    intent: true,
    policyAccepted: !!user?.affiliateOnboarding?.policyAccepted,
    policyVersion: user?.affiliateOnboarding?.policyVersion || '',
    policyAcceptedAt: user?.affiliateOnboarding?.policyAcceptedAt || null,
    taxCode: String(user?.affiliateOnboarding?.taxCode || '').replace(/\s+/g, ''),
    taxReview: {
      status: user?.affiliateOnboarding?.taxReview?.status || 'none',
      lookupAttested: user?.affiliateOnboarding?.taxReview?.lookupAttested === true,
      reason: user?.affiliateOnboarding?.taxReview?.reason || '',
      source: 'manual_public_lookup',
      grantsElectronicIdentity: false,
      grantsAffiliateEligibility: false,
    },
  };
  if (acceptAffiliatePolicy === true) {
    next.policyAccepted = true;
    next.policyVersion = AFFILIATE_POLICY_VERSION;
    next.policyAcceptedAt = new Date();
  }
  if (taxCode !== undefined) {
    const code = String(taxCode || '').replace(/\s+/g, '');
    if (!isValidTaxCode(code, 'INDIVIDUAL')) {
      return { ok: false, code: 'TAX_CODE_INVALID', message: 'MST must be 10 digits, 10-3 digits, or a 12-digit personal number.' };
    }
    const changed = code !== next.taxCode;
    next.taxCode = code;
    if (changed || next.taxReview.status === 'none' || next.taxReview.status === 'rejected') {
      next.taxReview = {
        status: 'declared',
        lookupAttested: false,
        reason: '',
        source: 'manual_public_lookup',
        grantsElectronicIdentity: false,
        grantsAffiliateEligibility: false,
      };
    }
  }
  return { ok: true, affiliateOnboarding: next };
}

function reviewAffiliateTax(user, decision = {}) {
  if (!String(user?.affiliateOnboarding?.taxCode || '').trim()) {
    return { ok: false, code: 'TAX_CODE_REQUIRED', message: 'The affiliate has not declared an MST.' };
  }
  const decided = decideManualTaxReview(decision);
  if (!decided.ok) return decided;
  return {
    ok: true,
    taxReview: {
      status: decided.status,
      lookupAttested: decided.lookupAttested,
      reason: decided.reason,
      source: 'manual_public_lookup',
      grantsElectronicIdentity: false,
      grantsAffiliateEligibility: false,
      reviewedAt: new Date(),
    },
    issueAffiliateCode: false,
  };
}

function affiliateOnboardingView(user = {}) {
  const role = normalizeRole(user.role) || ROLE.BUYER;
  const intent = role === ROLE.AFFILIATE || user?.affiliateOnboarding?.intent === true;
  const tax = user?.affiliateOnboarding?.taxReview || {};
  const taxCode = String(user?.affiliateOnboarding?.taxCode || '').replace(/\s+/g, '');
  const taxApproved = tax.status === 'approved' && tax.lookupAttested === true;
  const email = emailIsVerified(user);
  const kyc = String(user?.kyc?.status || 'none') === 'verified';
  const policy = user?.affiliateOnboarding?.policyAccepted === true && !!user?.affiliateOnboarding?.policyVersion;
  return {
    role,
    intent,
    labelVi: 'Người tiếp thị liên kết',
    labelEn: 'Affiliate',
    singleLevel: true,
    multiLevel: false,
    downline: false,
    joinFee: false,
    codeIssuedAtSignup: false,
    canSell: false,
    canBuy: true,
    steps: {
      emailVerified: { done: email, required: true },
      internalKyc: { done: kyc, required: true, kind: 'internal_ekyc' },
      taxCode: {
        done: taxApproved,
        required: true,
        declared: !!taxCode,
        status: tax.status || 'none',
        taxCode: taxCode || '',
        method: 'manual_public_lookup',
        apiIntegration: false,
        lookupAttested: tax.lookupAttested === true,
        grantsElectronicIdentity: false,
      },
      policyAccepted: {
        done: policy,
        required: true,
        version: user?.affiliateOnboarding?.policyVersion || '',
        acceptedAt: user?.affiliateOnboarding?.policyAcceptedAt || null,
      },
      statutoryElectronicIdentity: {
        done: false,
        required: true,
        status: 'not_implemented',
      },
    },
    readyForCode: false,
    codeIssuance: 'closed_pending_electronic_identity',
  };
}

/** Link creation stays closed until a code already exists. Onboarding does not mint one. */
function affiliateLinkDenial(user) {
  const code = String(user?.affiliateCode || '').trim();
  if (code) return null;
  const onboarding = affiliateOnboardingView(user);
  return {
    status: 403,
    body: {
      code: 'ELECTRONIC_IDENTITY_NOT_IMPLEMENTED',
      message: 'A new affiliate code is not issued. Electronic identity for affiliates is not implemented, and a manual tax-code review does not replace it.',
      electronicIdentityStatus: 'not_implemented',
      onboarding,
    },
  };
}

module.exports = {
  AFFILIATE_POLICY_VERSION,
  resolveSignupRole,
  signupAffiliateFields,
  declareAffiliateTax,
  reviewAffiliateTax,
  affiliateOnboardingView,
  affiliateLinkDenial,
  emailIsVerified,
};

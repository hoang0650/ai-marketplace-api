const SellerProfile = require('../models/SellerProfile');
const { normalizeSellerType } = require('../finance/seller-types');

const PLATFORM_SELLER_SLUG = 'phai-gateways';

function isPlatformOperator(user) {
  return !!user && (user.role === 'admin' || user.creatorSlug === PLATFORM_SELLER_SLUG);
}

/**
 * Third-party sellers must be VERIFIED (+ seller agreement) before publishing.
 * Platform operators / admins may publish PLATFORM_DIRECT products.
 */
async function assertCanPublishProduct(user, { ownershipType = 'THIRD_PARTY_SELLER' } = {}) {
  if (!user) {
    const err = new Error('Authentication required');
    err.status = 401;
    throw err;
  }

  if (ownershipType === 'PLATFORM_DIRECT') {
    if (!isPlatformOperator(user)) {
      const err = new Error(
        'Only the platform operator may list PLATFORM_DIRECT products. Infrastructure providers are not sellers.',
      );
      err.status = 403;
      err.code = 'PLATFORM_DIRECT_FORBIDDEN';
      throw err;
    }
    return { allowed: true, ownershipType: 'PLATFORM_DIRECT' };
  }

  if (user.role === 'admin') {
    return { allowed: true, ownershipType: 'THIRD_PARTY_SELLER' };
  }

  const profile = await SellerProfile.findOne({ user: user._id }).lean();
  if (!profile) {
    const err = new Error(
      'Seller profile required. Complete seller onboarding and verification before publishing.',
    );
    err.status = 403;
    err.code = 'SELLER_PROFILE_REQUIRED';
    throw err;
  }

  if (profile.verificationStatus !== 'VERIFIED') {
    const err = new Error(
      `Seller verification status is ${profile.verificationStatus}. Only VERIFIED sellers may publish third-party products.`,
    );
    err.status = 403;
    err.code = 'SELLER_NOT_VERIFIED';
    err.verificationStatus = profile.verificationStatus;
    throw err;
  }

  if (!profile.sellerAgreementAcceptedAt) {
    const err = new Error('Seller agreement must be accepted before publishing.');
    err.status = 403;
    err.code = 'SELLER_AGREEMENT_REQUIRED';
    throw err;
  }

  return { allowed: true, ownershipType: 'THIRD_PARTY_SELLER', profile };
}

/** Seller types that must upload a business registration certificate (household business / company). */
const LICENSED_SELLER_TYPES = new Set(['HOUSEHOLD_BUSINESS', 'COMPANY', 'FOREIGN_COMPANY']);

/**
 * Quy chế 2.1, Mục VIII: a seller can only be approved (VERIFIED) once the account owner's
 * eKYC is verified; household businesses and companies/organizations must also have uploaded
 * their business registration certificate (licence) scan in eKYC.
 * Pure function — pass the seller profile and the owner's `user.kyc`.
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
/** Seller types offered at registration (tax policy 2026-10). */
const REGISTRATION_SELLER_TYPES = ['INDIVIDUAL', 'HOUSEHOLD_BUSINESS', 'COMPANY'];

/**
 * MST: 10 digits, 10-3 digits (branch), or - for individuals / household businesses - the 12-digit
 * CCCD number (personal identification number used as the tax code).
 */
function isValidTaxCode(raw, sellerType) {
  const v = String(raw || '').replace(/\s+/g, '');
  if (/^\d{10}(-\d{3})?$/.test(v)) return true;
  const t = normalizeSellerType(sellerType);
  return (t === 'INDIVIDUAL' || t === 'HOUSEHOLD_BUSINESS') && /^\d{12}$/.test(v);
}

/**
 * Seller type + MST are mandatory at registration. Pure: validates the submitted body merged over
 * the current profile. Household businesses / companies also need the ĐKKD number.
 * @returns {{ ok: true, sellerType: string } | { ok: false, code: string, message: string }}
 */
function validateSellerTaxInfo(body = {}, current = {}) {
  const rawType = body.sellerType !== undefined ? body.sellerType : current.sellerTypeDeclaredAt ? current.sellerType : '';
  if (!rawType) {
    return { ok: false, code: 'SELLER_TYPE_REQUIRED', message: 'Choose the seller type: individual, household business or company/organisation.' };
  }
  const sellerType = normalizeSellerType(rawType);
  const known = ['individual', 'household_business', 'enterprise', 'organization'].includes(String(rawType).toLowerCase()) || REGISTRATION_SELLER_TYPES.includes(String(rawType).toUpperCase());
  if (!known) {
    return { ok: false, code: 'SELLER_TYPE_INVALID', message: 'Seller type must be INDIVIDUAL, HOUSEHOLD_BUSINESS or COMPANY.' };
  }
  const taxCode = body.taxCode !== undefined ? body.taxCode : current.taxCode;
  if (!isValidTaxCode(taxCode, sellerType)) {
    return {
      ok: false,
      code: 'TAX_CODE_REQUIRED',
      message: 'A valid tax code (MST, 10 or 10-3 digits; individuals may use the 12-digit CCCD number) is required.',
    };
  }
  if (sellerType !== 'INDIVIDUAL') {
    const brn = body.businessRegistrationNumber !== undefined ? body.businessRegistrationNumber : current.businessRegistrationNumber;
    if (!String(brn || '').trim()) {
      return { ok: false, code: 'BUSINESS_REGISTRATION_REQUIRED', message: 'Household businesses and companies must enter the business registration (ĐKKD) number.' };
    }
  }
  return { ok: true, sellerType };
}

function sellerApprovalGate(profile, kyc) {
  const k = kyc && typeof kyc === 'object' ? kyc : {};

  if (String(k.status || 'none') !== 'verified') {
    return {
      ok: false,
      code: 'SELLER_KYC_REQUIRED',
      message: 'Seller identity (eKYC) must be verified before the seller can be approved.',
    };
  }
  const sellerType = normalizeSellerType(profile?.sellerType);
  if (profile && !isValidTaxCode(profile.taxCode, sellerType)) {
    return {
      ok: false,
      code: 'SELLER_TAX_INFO_REQUIRED',
      message: 'Seller type and tax code (MST) must be declared before the seller can be approved.',
    };
  }
  if (LICENSED_SELLER_TYPES.has(sellerType)) {
    const hasLicense = k.subjectType === 'organization' && Boolean(String(k.licenseObjectName || '').trim());
    if (!hasLicense) {
      return {
        ok: false,
        code: 'BUSINESS_LICENSE_REQUIRED',
        message:
          sellerType === 'HOUSEHOLD_BUSINESS'
            ? 'Household businesses must upload the household business registration certificate (eKYC → organization).'
            : 'Companies/organizations must upload the business registration certificate or an equivalent licence (eKYC → organization).',
      };
    }
  }
  if (String(profile?.manualTaxReview?.status || 'none') !== 'approved') {
    return {
      ok: false,
      code: 'MANUAL_TAX_REVIEW_REQUIRED',
      message: 'The supplier tax record must be manually reviewed before seller approval. That review does not verify electronic identity.',
    };
  }
  return { ok: true };
}

const TAX_IDENTITY_FIELDS = ['taxCode', 'sellerType', 'legalName', 'businessRegistrationNumber'];

/**
 * A tax-identity change, or a review that has never been approved, goes back to pending.
 * This does not write user.kyc. An approved review stays put when only unrelated fields change.
 */
function manualReviewAfterApplication({ before = {}, after = {}, current = null } = {}) {
  const changed = TAX_IDENTITY_FIELDS.some((key) => String(before[key] || '') !== String(after[key] || ''));
  const status = String(current?.status || 'none');
  const reset = status === 'none' || status === 'rejected' || changed;
  return {
    reset,
    demoteVerified: changed && String(after.verificationStatus || '') === 'VERIFIED',
  };
}

/**
 * Admin attestation that a person checked the public tax lookup. The server does not call that site
 * and the decision never changes user.kyc.
 */
function decideManualTaxReview({ actorRole, status, reason, lookupAttested } = {}) {
  const { normalizeRole } = require('./roles');
  if (normalizeRole(actorRole) !== 'admin') {
    return { ok: false, code: 'RBAC', message: 'Only an admin can record this review.' };
  }
  const next = String(status || '');
  if (next !== 'approved' && next !== 'rejected') {
    return { ok: false, code: 'STATUS_INVALID', message: 'status must be approved or rejected.' };
  }
  const why = String(reason || '').trim();
  if (why.length < 5 || why.length > 1000) {
    return { ok: false, code: 'REASON_REQUIRED', message: 'A review reason is required.' };
  }
  if (next === 'approved' && lookupAttested !== true) {
    return {
      ok: false,
      code: 'LOOKUP_ATTESTATION_REQUIRED',
      message: 'Approve only after checking the declared tax code on the public tax lookup. The server does not query that site.',
    };
  }
  return { ok: true, status: next, reason: why, lookupAttested: next === 'approved' };
}

async function getOrCreateSellerProfile(user, defaults = {}) {
  let profile = await SellerProfile.findOne({ user: user._id });
  if (profile) return profile;

  profile = await SellerProfile.create({
    user: user._id,
    displayName: defaults.displayName || user.name || '',
    contactEmail: defaults.contactEmail || user.email || '',
    legalName: defaults.legalName || user.name || '',
    verificationStatus: 'VERIFICATION_REQUIRED',
    complianceStatus: 'incomplete',
    ...defaults,
  });
  return profile;
}

module.exports = {
  PLATFORM_SELLER_SLUG,
  isPlatformOperator,
  assertCanPublishProduct,
  getOrCreateSellerProfile,
  sellerApprovalGate,
  LICENSED_SELLER_TYPES,
  REGISTRATION_SELLER_TYPES,
  isValidTaxCode,
  validateSellerTaxInfo,
  decideManualTaxReview,
  manualReviewAfterApplication,
};

const SellerProfile = require('../models/SellerProfile');

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
        'Only the platform operator may list PLATFORM_DIRECT products. Infra providers (RunPod, OpenRouter, …) are not sellers.',
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
};

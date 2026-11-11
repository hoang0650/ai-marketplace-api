const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveSignupRole,
  signupAffiliateFields,
  declareAffiliateTax,
  reviewAffiliateTax,
  affiliateOnboardingView,
  affiliateLinkDenial,
  AFFILIATE_POLICY_VERSION,
} = require('../../src/finance/affiliate-onboarding');
const { affiliateParticipation } = require('../../src/finance/affiliate-engine');

test('register accepts buyer, seller and affiliate, and rejects unknown roles', () => {
  assert.equal(resolveSignupRole({}).role, 'buyer');
  assert.equal(resolveSignupRole({ role: 'seller' }).role, 'seller');
  assert.equal(resolveSignupRole({ role: 'affiliate' }).role, 'affiliate');
  assert.equal(resolveSignupRole({ asCreator: true }).role, 'seller');
  const bad = resolveSignupRole({ role: 'admin' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_ROLE');
  assert.deepEqual(bad.roles, ['buyer', 'seller', 'affiliate']);
  assert.equal(resolveSignupRole({ role: 'talent' }).code, 'INVALID_ROLE');
});

test('affiliate sign-up stores intent and does not issue a code', () => {
  const fields = signupAffiliateFields('affiliate', { acceptAffiliatePolicy: true, emailVerified: false });
  assert.equal(fields.affiliateCode, '');
  assert.equal(fields.affiliateOnboarding.intent, true);
  assert.equal(fields.affiliateOnboarding.policyAccepted, true);
  assert.equal(fields.affiliateOnboarding.policyVersion, AFFILIATE_POLICY_VERSION);
  assert.equal(fields.affiliateOnboarding.taxReview.status, 'none');
  assert.equal(fields.affiliateOnboarding.taxReview.lookupAttested, false);
  const buyer = signupAffiliateFields('buyer');
  assert.equal(buyer.affiliateOnboarding.intent, false);
  assert.equal(buyer.affiliateCode, '');
});

test('onboarding follows the operating rules and never treats a tax review as e-ID', () => {
  const declared = declareAffiliateTax(
    { role: 'affiliate', affiliateOnboarding: {} },
    { taxCode: '0123456789', acceptAffiliatePolicy: true },
  );
  assert.equal(declared.ok, true);
  assert.equal(declared.affiliateOnboarding.taxReview.status, 'declared');
  assert.equal(declared.affiliateOnboarding.taxReview.grantsElectronicIdentity, false);
  const user = {
    role: 'affiliate',
    emailVerified: true,
    kyc: { status: 'verified' },
    affiliateCode: '',
    affiliateOnboarding: declared.affiliateOnboarding,
  };
  const view = affiliateOnboardingView(user);
  assert.equal(view.steps.emailVerified.done, true);
  assert.equal(view.steps.internalKyc.done, true);
  assert.equal(view.steps.policyAccepted.done, true);
  assert.equal(view.steps.taxCode.done, false);
  assert.equal(view.steps.statutoryElectronicIdentity.done, false);
  assert.equal(view.readyForCode, false);
  assert.equal(view.multiLevel, false);
  assert.equal(view.downline, false);
  assert.equal(view.canSell, false);
  assert.equal(view.canBuy, true);
  const approved = reviewAffiliateTax(user, {
    actorRole: 'admin',
    status: 'approved',
    reason: 'Checked on the public tax lookup.',
    lookupAttested: true,
  });
  assert.equal(approved.ok, true);
  assert.equal(approved.issueAffiliateCode, false);
  assert.equal(approved.taxReview.grantsAffiliateEligibility, false);
  const skipped = reviewAffiliateTax(user, {
    actorRole: 'admin',
    status: 'approved',
    reason: 'No lookup.',
    lookupAttested: false,
  });
  assert.equal(skipped.code, 'LOOKUP_ATTESTATION_REQUIRED');
});

test('a new affiliate still cannot get a code', () => {
  const user = { role: 'affiliate', kyc: { status: 'verified' }, affiliateCode: '', affiliateOnboarding: { taxReview: { status: 'approved', lookupAttested: true }, taxCode: '0123456789' } };
  const denial = affiliateLinkDenial(user);
  assert.equal(denial.status, 403);
  assert.equal(denial.body.code, 'ELECTRONIC_IDENTITY_NOT_IMPLEMENTED');
  assert.equal(affiliateParticipation(user).code, null);
  assert.equal(affiliateParticipation(user).codeIssuance, 'closed_pending_electronic_identity');
  assert.equal(affiliateLinkDenial({ ...user, affiliateCode: 'AB1234' }), null);
});

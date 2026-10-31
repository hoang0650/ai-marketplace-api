/**
 * Phone shown on the admin user page.
 *
 * Checked, in order: User (no phone field), User.profile, User.kyc / eKYC,
 * User.invoiceProfile, Order (checkout has no phone), SellerProfile.contactPhone.
 * The only stored number is the shop contact phone. Nothing in the product
 * marks that number as verified, so `verified` stays null (unknown), never a
 * guessed true/false.
 */
function resolveAdminPhone({ sellerProfile } = {}) {
  const number = String(sellerProfile?.contactPhone || '').trim().slice(0, 40);
  if (!number) return { number: null, source: null, verified: null };
  return { number, source: 'shop', verified: null };
}

module.exports = { resolveAdminPhone };

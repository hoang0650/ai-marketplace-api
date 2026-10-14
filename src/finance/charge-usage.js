const WalletTx = require('../models/WalletTx');
const { settleSale } = require('./settlement-engine');
const { taxCategoryFromProduct } = require('./tax-category');

/** Short cache so per-request metering does not hit Mongo for the seller's tax profile every call. */
const PROFILE_TTL_MS = 60_000;
const profileCache = new Map();
async function sellerTaxProfileFor(sellerId) {
  const key = String(sellerId || '');
  if (!key) return null;
  const hit = profileCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const { resolveSellerTaxProfile } = require('./settlement-service');
  const value = await resolveSellerTaxProfile(sellerId).catch(() => null);
  if (profileCache.size > 5000) profileCache.clear();
  profileCache.set(key, { value, exp: Date.now() + PROFILE_TTL_MS });
  return value;
}

/**
 * Usage / metered charge: same settlement as checkout (commission ≠ tax).
 * PLATFORM_DIRECT does not credit a third-party seller.
 */
async function chargeUsage({
  buyerId,
  sellerId,
  product,
  cost,
  currency = 'USD',
  note = 'Usage',
  digits = 6,
  commissionRules = [],
  taxRules = [],
  storeFeeRules = [],
  salesChannel = 'WEB',
  sellerTaxProfile = null,
}) {
  const ownershipType = product?.ownershipType || 'THIRD_PARTY_SELLER';
  const selfUse = String(buyerId) === String(sellerId);
  if (!(cost > 0) || selfUse) {
    return { charged: 0, sellerNet: 0, platformFee: 0, settlement: null, skipped: true };
  }

  // Use the seller's real tax profile (type) unless the caller passed one; previously null here meant
  // the engine default (INDIVIDUAL) for every usage event.
  const taxProfile = sellerTaxProfile || (ownershipType === 'THIRD_PARTY_SELLER' ? await sellerTaxProfileFor(sellerId) : null);

  const settlement = settleSale({
    unitPrice: cost,
    quantity: 1,
    ownershipType,
    product: { ...product, taxCategory: taxCategoryFromProduct(product) },
    seller: { _id: sellerId },
    sellerTaxProfile: taxProfile,
    commissionRules,
    taxRules,
    storeFeeRules,
    salesChannel,
    currency,
    digits,
  });

  await WalletTx.create({
    user: buyerId,
    type: 'debit',
    amount: settlement.grossAmount,
    currency,
    note,
  });

  if (ownershipType === 'THIRD_PARTY_SELLER' && settlement.sellerNetAmount > 0) {
    await WalletTx.create({
      user: sellerId,
      type: 'credit',
      amount: settlement.sellerNetAmount,
      currency,
      note: `${note} (seller payable after commission/tax)`,
    });
  }

  return {
    charged: settlement.grossAmount,
    sellerNet: settlement.sellerNetAmount,
    platformFee: settlement.platformRevenueAmount,
    settlement,
    skipped: false,
  };
}

module.exports = { chargeUsage, sellerTaxProfileFor, _profileCache: profileCache };

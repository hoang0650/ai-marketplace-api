const WalletTx = require('../models/WalletTx');
const { settleSale } = require('./settlement-engine');
const { taxCategoryFromProduct } = require('./tax-category');

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
  sellerTaxProfile = null,
}) {
  const ownershipType = product?.ownershipType || 'THIRD_PARTY_SELLER';
  const selfUse = String(buyerId) === String(sellerId);
  if (!(cost > 0) || selfUse) {
    return { charged: 0, sellerNet: 0, platformFee: 0, settlement: null, skipped: true };
  }

  const settlement = settleSale({
    unitPrice: cost,
    quantity: 1,
    ownershipType,
    product: { ...product, taxCategory: taxCategoryFromProduct(product) },
    seller: { _id: sellerId },
    sellerTaxProfile,
    commissionRules,
    taxRules,
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

module.exports = { chargeUsage };

const { PLATFORM_COMMISSION_RATE, PLATFORM_FEE_RATE, SELLER_TAX_RATE, roundMoney } = require('../finance/constants');
const { settleSale } = require('../finance/settlement-engine');

/**
 * Backward-compatible split using SettlementEngine (commission ≠ tax).
 * Prefer settleSale / settleSaleFromDb for new code.
 */
function splitRevenue(gross, { ownershipType = 'THIRD_PARTY_SELLER', taxRules = [], sellerTaxProfile = null } = {}) {
  const settled = settleSale({
    unitPrice: gross,
    quantity: 1,
    ownershipType,
    taxRules,
    sellerTaxProfile,
    digits: 2,
  });
  return {
    gross: settled.grossAmount,
    platformFee: settled.platformFee,
    sellerNet: settled.sellerNet,
    commissionRate: settled.commissionRate,
    commissionAmount: settled.commissionAmount,
    taxAmount: settled.taxAmount,
    storeFeeAmount: settled.storeFeeAmount,
    salesChannel: settled.salesChannel,
    platformRevenueAmount: settled.platformRevenueAmount,
  };
}

module.exports = { PLATFORM_FEE_RATE, PLATFORM_COMMISSION_RATE, SELLER_TAX_RATE, splitRevenue, roundMoney };

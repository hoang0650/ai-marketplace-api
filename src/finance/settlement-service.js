const CommissionRule = require('../models/CommissionRule');
const TaxRule = require('../models/TaxRule');
const SellerTaxProfile = require('../models/SellerTaxProfile');
const { settleSale } = require('./settlement-engine');

async function loadActiveCommissionRules() {
  return CommissionRule.find({ status: 'ACTIVE' }).lean();
}

async function loadActiveTaxRules() {
  return TaxRule.find({ status: 'ACTIVE' }).lean();
}

/** Store fees are no longer applied to orders (IAP is top-up only); kept for callers. */
async function loadActiveStoreFeeRules() {
  return [];
}

async function currentSellerTaxProfile(sellerId, at = new Date()) {
  if (!sellerId) return null;
  return SellerTaxProfile.findOne({
    sellerId,
    effectiveFrom: { $lte: at },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: at } }],
  })
    .sort({ version: -1, effectiveFrom: -1 })
    .lean();
}

async function settleSaleFromDb(input) {
  const [commissionRules, taxRules, sellerTaxProfile] = await Promise.all([
    loadActiveCommissionRules(),
    loadActiveTaxRules(),
    currentSellerTaxProfile(input.sellerId || input.seller?._id, input.transactionDate),
  ]);
  return settleSale({
    ...input,
    commissionRules,
    taxRules,
    sellerTaxProfile,
  });
}

module.exports = {
  settleSaleFromDb,
  loadActiveCommissionRules,
  loadActiveTaxRules,
  loadActiveStoreFeeRules,
  currentSellerTaxProfile,
};

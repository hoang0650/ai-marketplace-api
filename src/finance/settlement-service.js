const CommissionRule = require('../models/CommissionRule');
const TaxRule = require('../models/TaxRule');
const StoreFeeRule = require('../models/StoreFeeRule');
const SellerTaxProfile = require('../models/SellerTaxProfile');
const { settleSale } = require('./settlement-engine');

async function loadActiveCommissionRules() {
  return CommissionRule.find({ status: 'ACTIVE' }).lean();
}

async function loadActiveTaxRules() {
  return TaxRule.find({ status: 'ACTIVE' }).lean();
}

async function loadActiveStoreFeeRules() {
  return StoreFeeRule.find({ status: 'ACTIVE' }).lean();
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
  const [commissionRules, taxRules, storeFeeRules, sellerTaxProfile] = await Promise.all([
    loadActiveCommissionRules(),
    loadActiveTaxRules(),
    loadActiveStoreFeeRules(),
    currentSellerTaxProfile(input.sellerId || input.seller?._id, input.transactionDate),
  ]);
  return settleSale({
    ...input,
    commissionRules,
    taxRules,
    storeFeeRules,
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

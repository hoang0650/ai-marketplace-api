const CommissionRule = require('../models/CommissionRule');
const TaxRule = require('../models/TaxRule');
const SellerTaxProfile = require('../models/SellerTaxProfile');
const SellerProfile = require('../models/SellerProfile');
const { settleSale } = require('./settlement-engine');
const { taxConfig } = require('../config/tax');

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

/**
 * Seller revenue (price after discount) on paid orders since 1 January of the transaction year, in VND.
 * Used for the individual annual-revenue threshold. Returns undefined when it cannot be computed.
 */
async function sellerAnnualRevenueVnd(sellerId, at = new Date()) {
  if (!sellerId) return undefined;
  try {
    const Order = require('../models/Order');
    const d = new Date(at);
    const from = new Date(Date.UTC(d.getUTCFullYear(), 0, 1) - 7 * 3600 * 1000); // 00:00 1/1 Asia/Bangkok
    const rows = await Order.find({
      seller: sellerId,
      status: 'paid',
      ownershipType: { $ne: 'PLATFORM_DIRECT' },
      createdAt: { $gte: from, $lte: d },
    }).select('currency grossAmount amount exchangeRate').lean();
    const live = Number(taxConfig().vndPerUsd);
    let total = 0;
    for (const r of rows) {
      const cur = String(r.currency || 'USD').toUpperCase();
      const amt = Number(r.grossAmount ?? r.amount) || 0;
      if (cur === 'VND') {
        total += amt;
        continue;
      }
      const locked = Number(r.exchangeRate?.vndPerUsd);
      const rate = locked > 0 ? locked : live;
      if (!(rate > 0)) return undefined;
      total += amt * rate;
    }
    return total;
  } catch {
    return undefined;
  }
}

/**
 * The seller's actual tax profile for settlement: the versioned SellerTaxProfile, else the seller type
 * declared on SellerProfile, else null (engine default). Same resolution for checkout and usage.
 */
async function resolveSellerTaxProfile(sellerId, at = new Date()) {
  if (!sellerId) return null;
  const [taxProfile, sellerProfile] = await Promise.all([
    currentSellerTaxProfile(sellerId, at).catch(() => null),
    SellerProfile.findOne({ user: sellerId }).select('sellerType').lean().catch(() => null),
  ]);
  return taxProfile || (sellerProfile?.sellerType ? { sellerType: sellerProfile.sellerType, sellerId } : null);
}

async function settleSaleFromDb(input) {
  const sellerId = input.sellerId || input.seller?._id;
  const [commissionRules, taxRules, sellerTaxProfile, annual] = await Promise.all([
    loadActiveCommissionRules(),
    loadActiveTaxRules(),
    // Seller type (mandatory at registration) comes from the tax profile, else the seller profile.
    resolveSellerTaxProfile(sellerId, input.transactionDate),
    input.sellerAnnualRevenueVnd !== undefined ? input.sellerAnnualRevenueVnd : sellerAnnualRevenueVnd(sellerId, input.transactionDate),
  ]);
  return settleSale({
    ...input,
    commissionRules,
    taxRules,
    sellerTaxProfile,
    sellerAnnualRevenueVnd: annual,
  });
}

module.exports = {
  settleSaleFromDb,
  loadActiveCommissionRules,
  loadActiveTaxRules,
  loadActiveStoreFeeRules,
  currentSellerTaxProfile,
  resolveSellerTaxProfile,
  sellerAnnualRevenueVnd,
};

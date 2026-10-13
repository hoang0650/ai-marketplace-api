const { roundMoney } = require('./constants');
const { calculateSellerTax } = require('./seller-tax-policy');
const { taxConfig } = require('../config/tax');
const { calculateCommission } = require('./commission-engine');
const { calculateTax } = require('./tax-engine');
const { calculatePaymentFee } = require('./payment-fee-engine');
const { calculateStoreFee, normalizeSalesChannel } = require('./store-fee-engine');
const { taxCategoryFromProduct } = require('./tax-category');
const { normalizeSellerType } = require('./seller-types');
const { calculateAffiliateCommission } = require('./affiliate-engine');

/**
 * Single money calculation for checkout and usage.
 * Never: sellerNet = gross * 0.8
 */
function settleSale({
  unitPrice,
  quantity = 1,
  ownershipType = 'THIRD_PARTY_SELLER',
  seller,
  buyer,
  product,
  sellerTaxProfile,
  jurisdiction,
  transactionDate = new Date(),
  paymentMethod,
  salesChannel,
  commissionRules = [],
  taxRules = [],
  paymentFeeRules = [],
  storeFeeRules = [],
  refundAmount = 0,
  chargebackAmount = 0,
  /** Seller-chosen affiliate rate (0–0.25), snapshotted by the caller; only when attributed. */
  affiliateRate = 0,
  /** Seller revenue earlier this calendar year in VND (threshold check); undefined = unknown. */
  sellerAnnualRevenueVnd,
  currency = 'USD',
  digits = 2,
} = {}) {
  const qty = Math.max(1, Number(quantity) || 1);
  const unit = roundMoney(unitPrice, digits);
  const grossAmount = roundMoney(unit * qty, digits);
  const taxCategory = taxCategoryFromProduct(product || {});
  const sellerType = normalizeSellerType(
    sellerTaxProfile?.sellerType || seller?.sellerType,
  );

  const commission = calculateCommission({
    ownershipType,
    sellerId: seller?._id || seller?.id || sellerTaxProfile?.sellerId,
    sellerType,
    category: product?.category,
    taxCategory,
    grossAmount,
    transactionDate,
    rules: commissionRules,
    digits,
  });

  const sellerShareAmount = roundMoney(Math.max(0, grossAmount - commission.commissionAmount), digits);
  // Tax policy 2026-10: tax base is the price after discount (order gross), by seller type.
  const taxableAmount = grossAmount;
  const policyTax = calculateSellerTax({
    sellerType,
    taxCategory,
    grossAmount: taxableAmount,
    currency,
    sellerAnnualRevenueVnd,
    digits,
  });
  // Admin-configured ACTIVE TaxRules (none are seeded) override the built-in policy when they match.
  let tax = calculateTax({
    seller,
    buyer,
    product,
    jurisdiction,
    transactionDate,
    taxCategory,
    taxableAmount,
    rules: taxRules,
    sellerTaxProfile,
    digits,
  });
  let taxPolicy = policyTax.policy;
  if (ownershipType === 'PLATFORM_DIRECT' || sellerType === 'PLATFORM') {
    tax = { taxApplicable: false, taxes: [], totalTaxAmount: 0, withholdingRequired: false, reason: 'PLATFORM_SALE_USES_OPERATOR_ACCOUNTING' };
    taxPolicy = { ...taxPolicy, rule: 'PLATFORM_SALE_USES_OPERATOR_ACCOUNTING' };
  } else if (tax.reason === 'RULE_MATCH') {
    taxPolicy = { ...taxPolicy, rule: 'ADMIN_TAX_RULE', rate: taxableAmount ? roundMoney(tax.totalTaxAmount / taxableAmount, 6) : 0 };
  } else {
    tax = policyTax;
  }
  const isCompany = sellerType === 'COMPANY' || sellerType === 'FOREIGN_COMPANY';

  const paymentFee = calculatePaymentFee({
    grossAmount,
    ownershipType,
    paymentMethod,
    transactionDate,
    rules: paymentFeeRules,
    digits,
  });

  const storeFee = calculateStoreFee({
    grossAmount,
    salesChannel: salesChannel || paymentMethod,
    transactionDate,
    rules: storeFeeRules,
    digits,
  });

  const feeIfSeller = paymentFee.borneBy === 'SELLER' ? paymentFee.amount : 0;
  const refund = roundMoney(refundAmount, digits);
  const chargeback = roundMoney(chargebackAmount, digits);
  const channel = normalizeSalesChannel(salesChannel || paymentMethod);

  let platformRevenueAmount;
  let sellerGrossAmount;
  let sellerNetAmount;
  let commissionAmount = commission.commissionAmount;
  let commissionRate = commission.rate;
  let affiliateCommissionAmount = 0;
  let appliedAffiliateRate = 0;

  if (ownershipType === 'PLATFORM_DIRECT' || sellerType === 'PLATFORM') {
    commissionRate = 0;
    commissionAmount = 0;
    sellerGrossAmount = 0;
    sellerNetAmount = 0;
    // Google/Apple still take IAP cut; remainder is platform proceeds.
    platformRevenueAmount = roundMoney(grossAmount - storeFee.amount, digits);
  } else {
    platformRevenueAmount = commissionAmount;
    sellerGrossAmount = grossAmount;
    // Affiliate commission comes out of the seller's share (never the platform fee or the tax).
    const aff = calculateAffiliateCommission({ baseAmount: grossAmount, rate: affiliateRate, currency, digits });
    appliedAffiliateRate = aff.rate;
    affiliateCommissionAmount = aff.amount;
    sellerNetAmount = roundMoney(
      grossAmount -
        commissionAmount -
        tax.totalTaxAmount -
        affiliateCommissionAmount -
        storeFee.amount -
        feeIfSeller -
        refund -
        chargeback,
      digits,
    );
  }

  return {
    unitPrice: unit,
    quantity: qty,
    grossAmount,
    commissionRate,
    commissionAmount,
    commissionRuleId: commission.ruleId,
    commissionRuleName: commission.ruleName,
    sellerShareAmount,
    taxableAmount,
    taxAmount: tax.totalTaxAmount,
    sellerType,
    taxPolicy,
    /** Company/organisation sellers receive a VAT invoice (10%) for the platform fee. */
    platformFeeInvoice: {
      required: isCompany && ownershipType !== 'PLATFORM_DIRECT',
      vatRate: taxConfig().platformFeeVatRate,
      feeAmount: ownershipType === 'PLATFORM_DIRECT' || sellerType === 'PLATFORM' ? 0 : commission.commissionAmount,
    },
    taxBreakdown: tax.taxes,
    taxApplicable: tax.taxApplicable,
    withholdingRequired: tax.withholdingRequired,
    paymentFeeRate: paymentFee.rate,
    paymentFeeAmount: feeIfSeller,
    paymentFeeBorneBy: paymentFee.borneBy,
    salesChannel: channel,
    storeFeeRate: storeFee.rate,
    storeFeeAmount: storeFee.amount,
    storeFeeCollector: storeFee.collector,
    storeFeeRuleName: storeFee.ruleName,
    refundAmount: refund,
    chargebackAmount: chargeback,
    sellerGrossAmount,
    sellerNetAmount: Math.max(0, sellerNetAmount),
    platformRevenueAmount,
    affiliateRate: appliedAffiliateRate,
    affiliateCommissionAmount,
    currency,
    taxCategory,
    /** Backward-compatible aliases */
    platformFee: platformRevenueAmount,
    sellerNet: Math.max(0, sellerNetAmount),
  };
}

module.exports = { settleSale };

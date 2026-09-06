const { roundMoney } = require('./constants');
const { calculateCommission } = require('./commission-engine');
const { calculateTax } = require('./tax-engine');
const { calculatePaymentFee } = require('./payment-fee-engine');
const { calculateStoreFee, normalizeSalesChannel } = require('./store-fee-engine');
const { taxCategoryFromProduct } = require('./tax-category');
const { normalizeSellerType } = require('./seller-types');

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

  const tax = calculateTax({
    seller,
    buyer,
    product,
    jurisdiction,
    transactionDate,
    taxCategory,
    taxableAmount: grossAmount,
    rules: taxRules,
    sellerTaxProfile,
    digits,
  });

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
    sellerNetAmount = roundMoney(
      grossAmount -
        commissionAmount -
        tax.totalTaxAmount -
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
    taxAmount: tax.totalTaxAmount,
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
    sellerNetAmount,
    platformRevenueAmount,
    currency,
    taxCategory,
    /** Backward-compatible aliases */
    platformFee: platformRevenueAmount,
    sellerNet: sellerNetAmount,
  };
}

module.exports = { settleSale };

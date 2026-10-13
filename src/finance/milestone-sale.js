const Order = require('../models/Order');
const WalletTx = require('../models/WalletTx');
const SellerProfile = require('../models/SellerProfile');
const { requireAvailableFunds } = require('../utils/wallet');
const { HOLD_MS } = require('../utils/payout-hold');
const { recordOrderLedger } = require('./ledger-service');
const { settleSaleFromDb } = require('./settlement-service');
const { recordTaxPostings } = require('./tax-posting');
const { issueOrderInvoices } = require('./invoice-service');
const { taxCategoryFromProduct } = require('./tax-category');

/**
 * Buyer accepted a hire phase: charge the wallet, credit the seller net and keep
 * that credit frozen for HOLD_MS (48h) so the buyer can still dispute it.
 * Throws 402 (INSUFFICIENT_WALLET / PAYOUT_HELD) before anything is written.
 */
async function chargeMilestone({ project, milestone, index, product, buyer }) {
  const amount = Number(milestone.amount) || 0;
  const currency = project.currency || product.pricing?.currency || 'USD';
  const ownershipType = product.ownershipType || 'THIRD_PARTY_SELLER';
  const plain = product.toObject ? product.toObject() : product;
  const settlement = await settleSaleFromDb({
    unitPrice: amount,
    quantity: 1,
    ownershipType,
    seller: { _id: project.seller, sellerType: undefined },
    sellerId: project.seller,
    buyer: { country: '' },
    product: plain,
    paymentMethod: 'internal_ledger',
    salesChannel: 'WEB',
    currency,
    digits: 2,
  });
  const gross = settlement.grossAmount;
  await requireAvailableFunds(buyer._id, gross, { currency });

  const now = new Date();
  const sellerProfile = await SellerProfile.findOne({ user: project.seller }).lean();
  const phaseName = `${product.name} · ${index + 1}/${project.milestones.length} ${milestone.title}`.slice(0, 300);
  const order = await Order.create({
    product: product._id,
    productName: phaseName,
    buyer: buyer._id,
    buyerName: buyer.name,
    seller: project.seller,
    ownershipType,
    quantity: 1,
    amount: gross,
    currency,
    unitPrice: settlement.unitPrice,
    listUnitPrice: amount,
    grossAmount: settlement.grossAmount,
    commissionRate: settlement.commissionRate,
    commissionAmount: settlement.commissionAmount,
    commissionRuleId: settlement.commissionRuleId,
    taxAmount: settlement.taxAmount,
    taxBreakdown: settlement.taxBreakdown,
    sellerType: settlement.sellerType || '',
    taxPolicy: settlement.taxPolicy || null,
    platformFeeInvoice: settlement.platformFeeInvoice || null,
    taxCategory: settlement.taxCategory || taxCategoryFromProduct(product),
    paymentFeeAmount: settlement.paymentFeeAmount,
    salesChannel: settlement.salesChannel,
    storeFeeRate: settlement.storeFeeRate,
    storeFeeAmount: settlement.storeFeeAmount,
    storeFeeCollector: settlement.storeFeeCollector || '',
    sellerGrossAmount: settlement.sellerGrossAmount,
    sellerNetAmount: settlement.sellerNetAmount,
    platformRevenueAmount: settlement.platformRevenueAmount,
    sellerNet: settlement.sellerNetAmount,
    platformFee: settlement.platformRevenueAmount,
    financialSnapshot: settlement,
    completedAt: now,
    payoutHoldUntil: ownershipType === 'THIRD_PARTY_SELLER' ? new Date(now.getTime() + HOLD_MS) : now,
    disputeStatus: 'none',
    status: 'paid',
    paymentStatus: 'paid',
    fulfillmentStatus: 'fulfilled',
    paymentProvider: 'internal_ledger',
    provider: 'wallet',
    hireProject: project._id,
    hireMilestone: index,
    contractSnapshot: {
      productName: phaseName,
      productDescription: String(project.brief || '').slice(0, 2000),
      sellerDisplayName: project.sellerName || product.creatorName,
      sellerLegalName: sellerProfile?.legalName || product.creatorName,
      ownershipType,
      pricing: { model: 'one-time', price: amount, currency, hireQuote: project.quote?.amount || 0 },
      license: product.license || '',
      termsSummary: product.termsSummary || '',
      infraProvider: '',
    },
  });

  if (gross > 0) {
    await WalletTx.create({
      user: buyer._id,
      type: 'debit',
      amount: gross,
      currency,
      note: `Order ${order._id} · ${phaseName} (hire milestone)`,
    });
    if (ownershipType === 'THIRD_PARTY_SELLER' && settlement.sellerNetAmount > 0) {
      await WalletTx.create({
        user: project.seller,
        type: 'credit',
        amount: settlement.sellerNetAmount,
        currency,
        note: `Seller payable: ${phaseName} (commission ${settlement.commissionAmount}, tax ${settlement.taxAmount})`,
      });
    }
    await recordOrderLedger({ order, settlement, ownershipType, currency }).catch((err) =>
      console.error('[ledger]', err.message),
    );
    await recordTaxPostings({ order, settlement }).catch((err) => console.error('[tax]', err.message));
    await issueOrderInvoices(order, settlement).catch((err) => console.error('[invoice]', err.message));
  }
  return { order, settlement };
}

module.exports = { chargeMilestone };

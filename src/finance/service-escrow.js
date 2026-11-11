'use strict';

const Order = require('../models/Order');
const WalletTx = require('../models/WalletTx');
const SellerProfile = require('../models/SellerProfile');
const { requireAvailableFunds } = require('../utils/wallet');
const { HOLD_MS, roundMoney } = require('../utils/payout-hold');
const { recordOrderLedger, recordAdjustmentLines, newEntryId } = require('./ledger-service');
const { settleSaleFromDb } = require('./settlement-service');
const { recordTaxPostings } = require('./tax-posting');
const { issueOrderInvoices } = require('./invoice-service');
const { taxCategoryFromProduct } = require('./tax-category');

function httpError(status, code) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * Seller net released for one accepted phase of a prepaid package.
 * The last phase takes the remainder so the slices sum to the planned net.
 */
function escrowSlice({ plannedSellerNet, total, milestoneAmount, releasedSellerNet, isLast } = {}) {
  const planned = roundMoney(plannedSellerNet);
  const already = roundMoney(releasedSellerNet);
  if (!(planned > 0) || !(total > 0) || !(milestoneAmount > 0)) return { netSlice: 0 };
  if (isLast) return { netSlice: roundMoney(Math.max(0, planned - already)) };
  const share = roundMoney(planned * (Number(milestoneAmount) / Number(total)));
  return { netSlice: roundMoney(Math.min(share, Math.max(0, planned - already))) };
}

/**
 * Buyer credit is the refunded gross. Seller debit is only the net already
 * released, scaled by the same ratio. Unreleased escrow is not clawed from
 * the seller because it was never credited.
 */
function escrowRefundPlan({ gross, releasedSellerNet, refundGross } = {}) {
  const paid = roundMoney(gross);
  const requested = roundMoney(refundGross);
  const buyerCredit = roundMoney(Math.min(paid, Math.max(0, requested)));
  const ratio = paid > 0 ? buyerCredit / paid : 0;
  const sellerDebit = roundMoney((Number(releasedSellerNet) || 0) * ratio);
  return { buyerCredit, sellerDebit };
}

/**
 * Debit the buyer for the whole package and keep the seller net uncredited
 * until a phase is accepted. Same wallet and order ledger as a milestone
 * charge. No second payment provider.
 */
async function holdPrepaidPackage({ project, product, buyer, amount }) {
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
  const sellerProfile = await SellerProfile.findOne({ user: project.seller }).lean();
  const now = new Date();
  const order = await Order.create({
    product: product._id,
    productName: String(product.name || project.productName || '').slice(0, 300),
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
    sellerNetAmount: 0,
    platformRevenueAmount: settlement.platformRevenueAmount,
    sellerNet: 0,
    platformFee: settlement.platformRevenueAmount,
    financialSnapshot: settlement,
    completedAt: now,
    payoutHoldUntil: null,
    disputeStatus: 'none',
    status: 'paid',
    paymentStatus: 'paid',
    fulfillmentStatus: 'pending',
    paymentProvider: 'internal_ledger',
    provider: 'wallet',
    hireProject: project._id,
    escrow: {
      status: 'held',
      plannedSellerNet: settlement.sellerNetAmount,
      releasedSellerNet: 0,
      releasedGross: 0,
      gross,
    },
    contractSnapshot: {
      productName: product.name,
      productDescription: String(project.brief || '').slice(0, 2000),
      sellerDisplayName: project.sellerName || product.creatorName,
      sellerLegalName: sellerProfile?.legalName || product.creatorName,
      ownershipType,
      pricing: { model: 'one-time', price: amount, currency, paymentChoice: 'prepaid' },
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
      note: `Order ${order._id} · ${product.name} (service prepaid escrow)`,
    });
    await recordOrderLedger({
      order,
      settlement: { ...settlement, sellerNetAmount: 0 },
      ownershipType,
      currency,
    }).catch((err) => console.error('[ledger]', err.message));
    await recordTaxPostings({ order, settlement }).catch((err) => console.error('[tax]', err.message));
    await issueOrderInvoices(order, settlement).catch((err) => console.error('[invoice]', err.message));
  }
  return { order, settlement };
}

/** Credit one accepted slice. The 48h payout hold starts at this release. */
async function releaseEscrowSlice({ orderId, total, milestoneAmount, isLast }) {
  const order = await Order.findById(orderId);
  if (!order || !order.escrow || (order.escrow.status !== 'held' && order.escrow.status !== 'partial')) {
    throw httpError(409, 'ESCROW_NOT_HELD');
  }
  if ((order.disputeStatus || 'none') === 'open') throw httpError(409, 'DISPUTE_OPEN');
  const { netSlice } = escrowSlice({
    plannedSellerNet: order.escrow.plannedSellerNet,
    total,
    milestoneAmount,
    releasedSellerNet: order.escrow.releasedSellerNet,
    isLast,
  });
  const grossSlice = isLast
    ? roundMoney(Math.max(0, Number(order.escrow.gross) - Number(order.escrow.releasedGross || 0)))
    : roundMoney(Number(order.escrow.gross) * (Number(milestoneAmount) / Number(total)));
  order.escrow.releasedSellerNet = roundMoney(Number(order.escrow.releasedSellerNet || 0) + netSlice);
  order.escrow.releasedGross = roundMoney(Number(order.escrow.releasedGross || 0) + grossSlice);
  const fully = isLast || order.escrow.releasedSellerNet + 0.001 >= Number(order.escrow.plannedSellerNet || 0);
  order.escrow.status = fully ? 'released' : 'partial';
  order.sellerNetAmount = order.escrow.releasedSellerNet;
  order.sellerNet = order.escrow.releasedSellerNet;
  order.payoutHoldUntil = new Date(Date.now() + HOLD_MS);
  if (fully) order.fulfillmentStatus = 'fulfilled';
  await order.save();
  if ((order.ownershipType || 'THIRD_PARTY_SELLER') === 'THIRD_PARTY_SELLER' && netSlice > 0) {
    await WalletTx.create({
      user: order.seller,
      type: 'credit',
      amount: netSlice,
      currency: order.currency || 'USD',
      note: `Seller payable: ${order.productName} (prepaid escrow release)`,
    });
    await recordAdjustmentLines({
      order,
      extra: [
        {
          entryId: newEntryId('escrow'),
          type: 'SELLER_PAYABLE',
          amount: netSlice,
          direction: 'credit',
          reference: `order:${order._id}:escrow-release`,
        },
      ],
    }).catch((err) => console.error('[ledger]', err.message));
  }
  return { order, netSlice };
}

module.exports = {
  escrowSlice,
  escrowRefundPlan,
  holdPrepaidPackage,
  releaseEscrowSlice,
};

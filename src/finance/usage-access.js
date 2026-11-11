'use strict';

const Product = require('../models/Product');
const Order = require('../models/Order');
const WalletTx = require('../models/WalletTx');
const UsageEntitlement = require('../models/UsageEntitlement');
const { requireAvailableFunds } = require('../utils/wallet');
const { HOLD_MS } = require('../utils/payout-hold');
const { unitByCode, accessPeriodEnd } = require('./usage-units');
const { settleSaleFromDb } = require('./settlement-service');
const { recordOrderLedger } = require('./ledger-service');
const { taxCategoryFromProduct } = require('./tax-category');
const { quoteAuthoritativeVnd } = require('./vnd-quote');

/** Ledger amount plus the server VND quote. A client rate is not an input. */
function quoteLedgerAmount({ amount, currency = 'USD', vndPerUsd, rateSource } = {}) {
  const quote = quoteAuthoritativeVnd({ amount, currency, vndPerUsd, rateSource });
  return {
    amount: Number(amount),
    currency: String(currency || 'USD').toUpperCase(),
    amountVnd: quote.amountVnd,
    vndQuote: quote,
  };
}

function httpError(status, code, message) {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  return err;
}

async function hasActiveUsageEntitlement(buyerId, productId, now = new Date()) {
  if (!buyerId || !productId) return false;
  const row = await UsageEntitlement.findOne({
    buyer: buyerId,
    product: productId,
    status: 'active',
    startsAt: { $lte: now },
    expiresAt: { $gt: now },
  })
    .select('_id expiresAt unit')
    .lean();
  return row || null;
}

/**
 * Buy one access period for a usage listing whose unit is day/week/month/year.
 * The charge is the listing usageRate through the wallet. The gateway then
 * allows calls until expiresAt and does not meter them.
 */
async function purchaseUsageAccess({ buyer, productId }) {
  const product = await Product.findById(productId);
  if (!product || product.published === false) throw httpError(404, 'PRODUCT_NOT_FOUND');
  const unit = unitByCode(product.pricing?.usageUnit);
  if (!unit || unit.kind !== 'entitlement') throw httpError(400, 'NOT_ACCESS_PERIOD');
  if (String(product.creator) === String(buyer._id)) throw httpError(400, 'OWN_PRODUCT');
  const rate = Number(product.pricing?.usageRate) || 0;
  if (!(rate > 0)) throw httpError(400, 'USAGE_RATE_REQUIRED');
  const currency = product.pricing?.currency || 'USD';
  const ownershipType = product.ownershipType || 'THIRD_PARTY_SELLER';
  const plain = product.toObject();
  const settlement = await settleSaleFromDb({
    unitPrice: rate,
    quantity: 1,
    ownershipType,
    seller: { _id: product.creator },
    sellerId: product.creator,
    buyer: { country: '' },
    product: plain,
    paymentMethod: 'internal_ledger',
    salesChannel: 'WEB',
    currency,
    digits: 2,
  });
  await requireAvailableFunds(buyer._id, settlement.grossAmount, { currency });
  const now = new Date();
  const order = await Order.create({
    product: product._id,
    productName: product.name,
    buyer: buyer._id,
    buyerName: buyer.name,
    seller: product.creator,
    ownershipType,
    quantity: 1,
    amount: settlement.grossAmount,
    currency,
    unitPrice: settlement.unitPrice,
    listUnitPrice: rate,
    grossAmount: settlement.grossAmount,
    commissionRate: settlement.commissionRate,
    commissionAmount: settlement.commissionAmount,
    taxAmount: settlement.taxAmount,
    taxBreakdown: settlement.taxBreakdown,
    sellerNetAmount: settlement.sellerNetAmount,
    sellerNet: settlement.sellerNetAmount,
    platformFee: settlement.platformRevenueAmount,
    platformRevenueAmount: settlement.platformRevenueAmount,
    financialSnapshot: settlement,
    taxCategory: taxCategoryFromProduct(product),
    completedAt: now,
    payoutHoldUntil: ownershipType === 'THIRD_PARTY_SELLER' ? new Date(now.getTime() + HOLD_MS) : now,
    status: 'paid',
    paymentStatus: 'paid',
    fulfillmentStatus: 'fulfilled',
    paymentProvider: 'internal_ledger',
    provider: 'wallet',
    contractSnapshot: {
      productName: product.name,
      pricing: product.pricing,
      licenseTerm: unit.period,
    },
  });
  if (settlement.grossAmount > 0) {
    await WalletTx.create({
      user: buyer._id,
      type: 'debit',
      amount: settlement.grossAmount,
      currency,
      note: `Order ${order._id} · ${product.name} · ${unit.labelEn} access`,
    });
    if (ownershipType === 'THIRD_PARTY_SELLER' && settlement.sellerNetAmount > 0) {
      await WalletTx.create({
        user: product.creator,
        type: 'credit',
        amount: settlement.sellerNetAmount,
        currency,
        note: `Seller payable: ${product.name} (access period)`,
      });
    }
    await recordOrderLedger({ order, settlement, ownershipType, currency }).catch((err) => console.error('[ledger]', err.message));
  }
  const entitlement = await UsageEntitlement.create({
    buyer: buyer._id,
    product: product._id,
    order: order._id,
    unit: unit.code,
    period: unit.period,
    startsAt: now,
    expiresAt: accessPeriodEnd(now, unit.period),
    status: 'active',
  });
  return { order, entitlement, unit };
}

module.exports = { hasActiveUsageEntitlement, purchaseUsageAccess, accessPeriodEnd, quoteLedgerAmount };

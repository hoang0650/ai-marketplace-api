const crypto = require('crypto');
const LedgerEntry = require('../models/LedgerEntry');

function newEntryId(prefix = 'led') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function stableId(orderId, kind) {
  return `ord_${String(orderId)}_${kind}`;
}

/**
 * Immutable marketplace ledger (reconciliation), not a licensed payment account.
 * Lines must conceptually balance: gross = platformRevenue + tax + storeFee + sellerFee + sellerPayable
 * (refunds/chargebacks posted as separate adjustment lines).
 */
async function recordOrderLedger({ order, settlement, ownershipType, currency }) {
  const s = settlement;
  const ot = ownershipType || order.ownershipType;
  const cur = currency || s.currency || order.currency || 'USD';
  const base = {
    orderId: order._id,
    sellerId: order.seller,
    buyerId: order.buyer,
    productId: order.product,
    currency: cur,
    ownershipType: ot,
  };

  const lines = [
    {
      ...base,
      entryId: stableId(order._id, 'customer_payment'),
      type: 'CUSTOMER_PAYMENT',
      amount: s.grossAmount,
      direction: 'credit',
      reference: `order:${order._id}:customer-payment`,
    },
  ];

  if (s.platformRevenueAmount > 0) {
    lines.push({
      ...base,
      entryId: stableId(order._id, 'platform_revenue'),
      type: 'PLATFORM_REVENUE',
      amount: s.platformRevenueAmount,
      direction: 'credit',
      reference: `order:${order._id}:platform-revenue`,
      meta: { commissionRate: s.commissionRate, commissionAmount: s.commissionAmount },
    });
  }

  if (s.taxAmount > 0) {
    lines.push({
      ...base,
      entryId: stableId(order._id, 'tax_payable'),
      type: 'TAX_PAYABLE',
      amount: s.taxAmount,
      direction: 'credit',
      reference: `order:${order._id}:tax-payable`,
      meta: { taxBreakdown: s.taxBreakdown },
    });
  }

  if (s.storeFeeAmount > 0) {
    lines.push({
      ...base,
      entryId: stableId(order._id, 'store_fee'),
      type: 'STORE_FEE',
      amount: s.storeFeeAmount,
      direction: 'debit',
      reference: `order:${order._id}:store-fee`,
      meta: {
        salesChannel: s.salesChannel,
        storeFeeRate: s.storeFeeRate,
        collector: s.storeFeeCollector,
      },
    });
  }

  if (s.paymentFeeAmount > 0) {
    lines.push({
      ...base,
      entryId: stableId(order._id, 'payment_fee'),
      type: 'PAYMENT_PROCESSING_FEE',
      amount: s.paymentFeeAmount,
      direction: 'debit',
      reference: `order:${order._id}:payment-fee`,
    });
  }

  if (ot === 'THIRD_PARTY_SELLER' && s.sellerNetAmount > 0) {
    lines.push({
      ...base,
      entryId: stableId(order._id, 'seller_payable'),
      type: 'SELLER_PAYABLE',
      amount: s.sellerNetAmount,
      direction: 'credit',
      reference: `order:${order._id}:seller-payable`,
    });
  }

  try {
    await LedgerEntry.insertMany(lines, { ordered: false });
  } catch (err) {
    if (err?.code !== 11000 && err?.code !== 11001) throw err;
  }
  return lines;
}

async function recordAdjustmentLines({ order, kind, amount, extra = [] }) {
  const base = {
    orderId: order._id,
    sellerId: order.seller,
    buyerId: order.buyer,
    productId: order.product,
    currency: order.currency || 'USD',
    ownershipType: order.ownershipType,
  };
  const lines = extra.length
    ? extra.map((l) => ({ ...base, ...l }))
    : [
        {
          ...base,
          entryId: newEntryId(kind),
          type: kind,
          amount,
          direction: 'debit',
          reference: `order:${order._id}:${kind.toLowerCase()}`,
        },
      ];
  await LedgerEntry.insertMany(lines);
  return lines;
}

function ledgerBalances(lines) {
  const byType = {};
  for (const l of lines) {
    const sign = l.direction === 'debit' ? -1 : 1;
    byType[l.type] = (byType[l.type] || 0) + sign * Number(l.amount);
  }
  return byType;
}

module.exports = {
  recordOrderLedger,
  recordAdjustmentLines,
  newEntryId,
  stableId,
  ledgerBalances,
};

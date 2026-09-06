const crypto = require('crypto');
const Refund = require('../models/Refund');
const Order = require('../models/Order');
const WalletTx = require('../models/WalletTx');
const { recordAdjustmentLines, newEntryId } = require('./ledger-service');
const { claimEvent } = require('./idempotency');
const { writeAuditLog } = require('../utils/audit');
const { roundMoney } = require('./constants');

function reverseSettlement(original, refundGross, digits = 2) {
  const gross = Number(original.grossAmount) || 0;
  const ratio = gross > 0 ? Math.min(1, refundGross / gross) : 1;
  const scale = (n) => roundMoney((Number(n) || 0) * ratio, digits);
  return {
    unitPrice: scale(original.unitPrice || original.grossAmount),
    quantity: original.quantity || 1,
    grossAmount: scale(gross),
    commissionRate: original.commissionRate,
    commissionAmount: scale(original.commissionAmount),
    taxAmount: scale(original.taxAmount),
    taxBreakdown: (original.taxBreakdown || []).map((t) => ({
      ...t,
      amount: scale(t.amount),
    })),
    paymentFeeAmount: scale(original.paymentFeeAmount),
    salesChannel: original.salesChannel || 'WEB',
    storeFeeRate: original.storeFeeRate || 0,
    storeFeeAmount: scale(original.storeFeeAmount),
    storeFeeCollector: original.storeFeeCollector || '',
    sellerGrossAmount: scale(original.sellerGrossAmount),
    sellerNetAmount: scale(original.sellerNetAmount ?? original.sellerNet),
    platformRevenueAmount: scale(original.platformRevenueAmount ?? original.commissionAmount),
    currency: original.currency,
    ownershipType: original.ownershipType,
  };
}

async function createRefund({
  order,
  amount,
  reason = '',
  actorId = null,
  eventId = null,
}) {
  const gross = Number(amount);
  if (!Number.isFinite(gross) || gross <= 0) {
    const err = new Error('Invalid refund amount');
    err.status = 400;
    throw err;
  }
  if (eventId) {
    const { duplicate } = await claimEvent({
      eventId,
      provider: 'internal',
      kind: 'refund',
      orderId: order._id,
    });
    if (duplicate) {
      const existing = await Refund.findOne({ orderId: order._id, amount: gross }).sort({ createdAt: -1 });
      return { refund: existing, duplicate: true };
    }
  }

  const snapshot = {
    ...((order.financialSnapshot && typeof order.financialSnapshot === 'object' && order.financialSnapshot) || {}),
    grossAmount: Number(order.amount) || 0,
    unitPrice: Number(order.amount) || 0,
    quantity: order.quantity || 1,
    commissionRate: order.commissionRate,
    commissionAmount: order.commissionAmount,
    taxAmount: order.taxAmount,
    taxBreakdown: order.taxBreakdown || [],
    storeFeeAmount: order.storeFeeAmount || 0,
    salesChannel: order.salesChannel || 'WEB',
    ownershipType: order.ownershipType,
    currency: order.currency,
    taxCategory: order.taxCategory,
  };
  const reversed = reverseSettlement(snapshot, Math.min(gross, snapshot.grossAmount || gross));
  const refundId = `ref_${crypto.randomBytes(8).toString('hex')}`;

  const extra = [
    {
      entryId: newEntryId('refund'),
      type: 'REFUND',
      amount: reversed.grossAmount,
      direction: 'debit',
      reference: `refund:${refundId}:gross`,
    },
  ];
  if (reversed.platformRevenueAmount > 0) {
    extra.push({
      entryId: newEntryId('ref_rev'),
      type: 'PLATFORM_REVENUE',
      amount: reversed.platformRevenueAmount,
      direction: 'debit',
      reference: `refund:${refundId}:commission`,
    });
  }
  if (reversed.taxAmount > 0) {
    extra.push({
      entryId: newEntryId('ref_tax'),
      type: 'TAX_PAYABLE',
      amount: reversed.taxAmount,
      direction: 'debit',
      reference: `refund:${refundId}:tax`,
    });
  }
  if (reversed.storeFeeAmount > 0) {
    extra.push({
      entryId: newEntryId('ref_store'),
      type: 'STORE_FEE',
      amount: reversed.storeFeeAmount,
      direction: 'credit',
      reference: `refund:${refundId}:store-fee`,
    });
  }
  if (order.ownershipType === 'THIRD_PARTY_SELLER' && reversed.sellerNetAmount > 0) {
    extra.push({
      entryId: newEntryId('ref_pay'),
      type: 'SELLER_PAYABLE',
      amount: reversed.sellerNetAmount,
      direction: 'debit',
      reference: `refund:${refundId}:seller`,
    });
  }

  const refund = await Refund.create({
    refundId,
    orderId: order._id,
    amount: reversed.grossAmount,
    currency: order.currency || 'USD',
    reason,
    status: 'PROCESSED',
    settlement: reversed,
    createdBy: actorId,
  });

  await recordAdjustmentLines({ order, extra });

  if (order.ownershipType === 'THIRD_PARTY_SELLER' && reversed.sellerNetAmount > 0) {
    await WalletTx.create({
      user: order.seller,
      type: 'debit',
      amount: reversed.sellerNetAmount,
      currency: order.currency || 'USD',
      note: `Refund clawback ${refundId} order ${order._id}`,
    });
  }
  await WalletTx.create({
    user: order.buyer,
    type: 'credit',
    amount: reversed.grossAmount,
    currency: order.currency || 'USD',
    note: `Refund ${refundId} order ${order._id}`,
  });

  await Order.updateOne(
    { _id: order._id },
    {
      $set: { status: 'refunded', paymentStatus: 'refunded' },
      $inc: {
        refundAmount: reversed.grossAmount,
      },
    },
  );

  const { revokeLicensesForOrder } = require('../utils/issue-license');
  await revokeLicensesForOrder(order._id).catch(() => {});

  await writeAuditLog({
    actorId,
    action: 'REFUND_CREATED',
    resourceType: 'Refund',
    resourceId: refundId,
    newValue: { orderId: String(order._id), amount: reversed.grossAmount },
    reason,
  });

  return { refund, reversed, duplicate: false };
}

module.exports = { createRefund, reverseSettlement };

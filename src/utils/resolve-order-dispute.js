const Order = require('../models/Order');
const { notifyUser } = require('./notify');
const { createRefund } = require('../finance/refund-service');
const { writeAuditLog } = require('./audit');
const { roundMoney } = require('./payout-hold');
const {
  ADMIN_DISPUTE_LABEL,
  OUTCOME_VI,
  planDisputeResolution,
  ensureThread,
} = require('./dispute-access');

/**
 * Close an open order dispute.
 * seller  → existing path: mark seller_win so the 48h/dispute hold releases. No wallet write.
 * buyer   → existing path: createRefund for the full gross, or a smaller amount (partial).
 * split   → same createRefund for the buyer's share; the unclawed seller net stays and the
 *           hold releases because disputeStatus `split` is not `open`.
 * Does not touch top-up / VietQR.
 */
async function resolveOrderDispute(order, { resolution, note = '', actorId, refundAmount, requireNote = false } = {}, deps = {}) {
  const notify = deps.notifyUser || notifyUser;
  const refundFn = deps.createRefund || createRefund;
  const audit = deps.writeAuditLog || writeAuditLog;
  const findById = deps.findById || ((id) => Order.findById(id));
  const updateOne = deps.updateOne || ((id, update) => Order.updateOne({ _id: id }, update));
  const plan = planDisputeResolution(order, { resolution, note, refundAmount, requireNote });
  const currency = order.currency || 'USD';
  const resolvedAt = new Date();

  order.disputeStatus = plan.disputeStatus;
  order.disputeOutcome = plan.outcome;
  order.disputeResolvedAt = resolvedAt;
  order.disputeResolutionNote = plan.note;
  order.disputeRefundAmount = plan.refundGross;
  order.disputeSellerKeptAmount = plan.sellerKept;
  if (plan.resolution === 'buyer' && plan.refundGross <= 0) {
    order.status = 'refunded';
    order.paymentStatus = 'refunded';
  }
  ensureThread(order);
  order.disputeMessages.push({
    author: actorId || null,
    authorName: ADMIN_DISPUTE_LABEL,
    role: 'admin',
    kind: 'decision',
    outcome: plan.outcome,
    body: plan.note,
    attachments: [],
    at: resolvedAt,
  });
  order.disputeEvents.push({
    at: resolvedAt,
    actorId: actorId || null,
    actorRole: 'admin',
    action: 'resolved',
    note: `${plan.outcome}${plan.note ? `: ${plan.note}` : ''}`.slice(0, 200),
  });
  await order.save();

  let duplicate = false;
  let grossRefunded = plan.refundGross;
  let netReversed = roundMoney(plan.sellerNet * plan.ratio);
  if (plan.refundGross > 0) {
    const result = await refundFn({
      order,
      amount: plan.refundGross,
      reason: plan.note || `dispute ${plan.outcome}`,
      actorId,
      eventId: `dispute_refund_${order._id}`,
    });
    if (result.duplicate) {
      duplicate = true;
    } else {
      grossRefunded = result.reversed?.grossAmount ?? result.refund?.amount ?? grossRefunded;
      netReversed = result.reversed?.sellerNetAmount ?? netReversed;
      await updateOne(order._id, {
        $set: {
          disputeRefundAmount: grossRefunded,
          disputeSellerKeptAmount: roundMoney(Math.max(0, plan.sellerNet - netReversed)),
        },
      });
    }
  }
  if (duplicate) {
    const fresh = await findById(order._id);
    return fresh || order;
  }

  if (plan.resolution === 'seller') {
    await notify(order.seller, 'dispute.closedSeller', { product: order.productName }, '/sell/withdraw');
    await notify(order.buyer, 'dispute.closedBuyer', { product: order.productName }, '/complaints');
  } else {
    await notify(
      order.buyer,
      'dispute.refundBuyer',
      { amount: Number(grossRefunded).toFixed(2), currency, product: order.productName },
      '/wallet',
    );
    await notify(
      order.seller,
      'dispute.refundSeller',
      { amount: Number(netReversed).toFixed(2), currency, product: order.productName },
      '/sell/orders',
    );
    if (plan.outcome !== 'buyer_full') {
      const params = {
        product: order.productName,
        outcome: OUTCOME_VI[plan.outcome] || plan.outcome,
        outcomeCode: plan.outcome,
        reason: plan.note,
      };
      const href = `/orders/${order._id}`;
      await notify(order.buyer, 'dispute.decided', params, href);
      await notify(order.seller, 'dispute.decided', params, href);
    }
  }

  await audit({
    actorId,
    actorRole: 'admin',
    action: 'dispute.resolve',
    resourceType: 'Order',
    resourceId: String(order._id),
    oldValue: { disputeStatus: 'open' },
    newValue: {
      disputeStatus: plan.disputeStatus,
      outcome: plan.outcome,
      refundGross: grossRefunded,
      sellerKept: roundMoney(Math.max(0, plan.sellerNet - netReversed)),
    },
    reason: plan.note,
  });

  const fresh = await findById(order._id);
  return fresh || order;
}

module.exports = { resolveOrderDispute };

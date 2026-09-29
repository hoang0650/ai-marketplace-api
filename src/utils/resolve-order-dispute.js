const { notifyUser } = require('./notify');
const { effectiveSellerNet } = require('./payout-hold');
const { createRefund } = require('../finance/refund-service');

async function resolveOrderDispute(order, { resolution, note = '', actorId }) {
  if (order.disputeStatus !== 'open') {
    const err = new Error('This order has no open dispute');
    err.status = 400;
    throw err;
  }
  if (!['seller', 'buyer'].includes(resolution)) {
    const err = new Error('resolution must be seller or buyer');
    err.status = 400;
    throw err;
  }
  const text = String(note || '').slice(0, 1000);
  order.disputeResolvedAt = new Date();
  order.disputeResolutionNote = text;

  if (resolution === 'seller') {
    order.disputeStatus = 'seller_win';
    await order.save();
    await notifyUser(order.seller, 'dispute.closedSeller', { product: order.productName }, '/sell/withdraw');
    await notifyUser(order.buyer, 'dispute.closedBuyer', { product: order.productName }, '/complaints');
    return order;
  }

  order.disputeStatus = 'buyer_win';
  await order.save();
  const currency = order.currency || 'USD';
  let gross = Number(order.amount) || 0;
  let net = effectiveSellerNet(order);
  if (gross > 0) {
    const { reversed } = await createRefund({
      order,
      amount: gross,
      reason: text || 'dispute buyer_win',
      actorId,
      eventId: `dispute_refund_${order._id}`,
    });
    gross = reversed.grossAmount;
    net = reversed.sellerNetAmount;
  } else {
    order.status = 'refunded';
    order.paymentStatus = 'refunded';
    await order.save();
  }
  await notifyUser(
    order.buyer,
    'dispute.refundBuyer',
    { amount: gross.toFixed(2), currency, product: order.productName },
    '/wallet',
  );
  await notifyUser(
    order.seller,
    'dispute.refundSeller',
    { amount: net.toFixed(2), currency, product: order.productName },
    '/sell/orders',
  );
  return order;
}

module.exports = { resolveOrderDispute };

const Notification = require('../models/Notification');
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
    await Notification.create({
      user: order.seller,
      title: 'Khiếu nại đã đóng',
      body: `Dispute on ${order.productName} resolved for the seller. Payout is now withdrawable.`,
      href: '/sell/withdraw',
    });
    await Notification.create({
      user: order.buyer,
      title: 'Khiếu nại đã đóng',
      body: `Dispute on ${order.productName} was resolved in the seller's favor.`,
      href: '/complaints',
    });
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
  await Notification.create({
    user: order.buyer,
    title: 'Hoàn tiền khiếu nại',
    body: `Refunded ${gross.toFixed(2)} ${currency} for ${order.productName}.`,
    href: '/wallet',
  });
  await Notification.create({
    user: order.seller,
    title: 'Khiếu nại: hoàn tiền người mua',
    body: `Seller payable ${net.toFixed(2)} ${currency} for ${order.productName} was reversed (commission/tax adjusted on ledger).`,
    href: '/sell/orders',
  });
  return order;
}

module.exports = { resolveOrderDispute };

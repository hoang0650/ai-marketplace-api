const Notification = require('../models/Notification');
const { canOpenDispute } = require('./payout-hold');

async function openOrderDispute(order, { reason, actorName, href = '/sell/complaints' }) {
  if (!canOpenDispute(order)) {
    const err = new Error(
      'Cannot dispute this order. Disputes are only allowed within 48 hours of completion, and only once.',
    );
    err.status = 400;
    err.code = 'DISPUTE_WINDOW_CLOSED';
    throw err;
  }
  const text = String(reason || '').trim().slice(0, 1000);
  if (text.length < 8) {
    const err = new Error('Please describe the issue (at least 8 characters)');
    err.status = 400;
    throw err;
  }
  order.disputeStatus = 'open';
  order.disputeReason = text;
  order.disputeOpenedAt = new Date();
  await order.save();
  await Notification.create({
    user: order.seller,
    title: 'Khiếu nại đơn hàng',
    body: `${actorName} disputed ${order.productName}. Seller net is frozen until resolved.`,
    href,
  });
  return order;
}

module.exports = { openOrderDispute };

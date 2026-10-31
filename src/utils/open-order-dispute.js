const { notifyUser } = require('./notify');
const { applyDisputeOpen } = require('./dispute-access');

async function openOrderDispute(order, opts = {}) {
  applyDisputeOpen(order, opts);
  await order.save();
  await notifyUser(
    order.seller,
    'dispute.opened',
    { actor: opts.actorName, product: order.productName },
    opts.href || '/sell/complaints',
  );
  return order;
}

module.exports = { openOrderDispute };

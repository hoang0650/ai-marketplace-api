const Order = require('../models/Order');
const { splitRevenue } = require('./platform');

const HOLD_HOURS = Math.max(1, Number(process.env.PAYOUT_HOLD_HOURS || 48));
const HOLD_MS = HOLD_HOURS * 60 * 60 * 1000;

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Seller proceeds for this order only (never the rest of the wallet). */
function effectiveSellerNet(order) {
  const n = Number(order.sellerNet);
  if (Number.isFinite(n) && n > 0) return roundMoney(n);
  return splitRevenue(order.amount).sellerNet;
}

function holdUntil(order) {
  if (order.payoutHoldUntil) return new Date(order.payoutHoldUntil);
  const start = order.completedAt || order.createdAt || Date.now();
  return new Date(new Date(start).getTime() + HOLD_MS);
}

/**
 * Only the seller-net of this order is frozen — never the rest of the wallet.
 * Held while: protection window still open, or an open dispute exists.
 */
function isPayoutHeld(order, now = new Date()) {
  if ((order.status || 'paid') !== 'paid') return false;
  const net = effectiveSellerNet(order);
  if (net <= 0) return false;
  const ds = order.disputeStatus || 'none';
  if (ds === 'buyer_win' || ds === 'seller_win') return false;
  if (ds === 'open') return true;
  return now < holdUntil(order);
}

function holdKind(order, now = new Date()) {
  if (!isPayoutHeld(order, now)) return null;
  if ((order.disputeStatus || 'none') === 'open') return 'dispute';
  return 'protection_window';
}

function canOpenDispute(order, now = new Date()) {
  if ((order.status || 'paid') !== 'paid') return false;
  if ((order.disputeStatus || 'none') !== 'none') return false;
  const net = effectiveSellerNet(order);
  if (net <= 0 && !(Number(order.amount) > 0)) return false;
  return now < holdUntil(order);
}

async function getSellerHolds(sellerId) {
  const orders = await Order.find({
    seller: sellerId,
    status: 'paid',
  })
    .sort({ createdAt: -1 })
    .lean();
  const now = new Date();
  const holds = [];
  let held = 0;
  for (const o of orders) {
    if (!isPayoutHeld(o, now)) continue;
    const amount = effectiveSellerNet(o);
    if (amount <= 0) continue;
    held += amount;
    holds.push({
      orderId: String(o._id),
      productName: o.productName,
      amount,
      currency: o.currency || 'USD',
      kind: holdKind(o, now),
      holdUntil: holdUntil(o).toISOString(),
      disputeStatus: o.disputeStatus || 'none',
      disputeReason: o.disputeReason || '',
    });
  }
  return { held: roundMoney(held), holds };
}

module.exports = {
  HOLD_HOURS,
  HOLD_MS,
  roundMoney,
  effectiveSellerNet,
  holdUntil,
  isPayoutHeld,
  holdKind,
  canOpenDispute,
  getSellerHolds,
};

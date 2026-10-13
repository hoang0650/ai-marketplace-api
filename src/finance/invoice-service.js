const OrderInvoice = require('../models/OrderInvoice');
const { NO_INVOICE_BUYER_NAME, endOfVnDay } = require('../utils/invoice');

/** Create the per-order invoice record (default: buyer does not want an invoice). Idempotent. */
async function ensureOrderInvoice(order) {
  if (!order?._id) return null;
  const existing = await OrderInvoice.findOne({ order: order._id });
  if (existing) return existing;
  const orderedAt = order.createdAt || new Date();
  try {
    return await OrderInvoice.create({
      order: order._id,
      buyer: order.buyer?._id || order.buyer,
      seller: order.seller?._id || order.seller || null,
      productName: order.productName || '',
      amount: Number(order.amount) || 0,
      currency: order.currency || 'USD',
      orderedAt,
      wantsInvoice: false,
      buyerType: 'none',
      buyerName: NO_INVOICE_BUYER_NAME,
      editableUntil: endOfVnDay(orderedAt),
    });
  } catch (e) {
    if (e && e.code === 11000) return OrderInvoice.findOne({ order: order._id });
    throw e;
  }
}

module.exports = { ensureOrderInvoice };

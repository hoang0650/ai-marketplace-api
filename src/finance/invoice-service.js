const crypto = require('crypto');
const Invoice = require('../models/Invoice');
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

/**
 * Accounting invoices for one paid order: platform revenue + (marketplace sales) the seller invoice.
 * Restored: billing checkout and milestone sales still call this; it was dropped by mistake, which
 * made every paid checkout throw after the wallet debit (HTTP 500 with the money already taken).
 */
async function issueOrderInvoices(order, settlement) {
  const invoices = [];
  const suffix = String(order._id).slice(-8);
  if (settlement.platformRevenueAmount > 0) {
    invoices.push(
      await Invoice.create({
        invoiceNumber: `PLAT-${suffix}`,
        kind: 'PLATFORM_INVOICE',
        orderId: order._id,
        sellerId: order.seller,
        buyerId: order.buyer,
        currency: order.currency || 'USD',
        subtotal: settlement.platformRevenueAmount,
        taxAmount: 0,
        total: settlement.platformRevenueAmount,
        items: [
          {
            description: `Marketplace commission / platform revenue · ${order.productName}`,
            amount: settlement.platformRevenueAmount,
            quantity: 1,
          },
        ],
      }),
    );
  }
  if (order.ownershipType === 'THIRD_PARTY_SELLER' && settlement.sellerGrossAmount > 0) {
    invoices.push(
      await Invoice.create({
        invoiceNumber: `SEL-${suffix}-${crypto.randomBytes(2).toString('hex')}`,
        kind: 'SELLER_INVOICE',
        orderId: order._id,
        sellerId: order.seller,
        buyerId: order.buyer,
        currency: order.currency || 'USD',
        subtotal: settlement.sellerGrossAmount,
        taxAmount: settlement.taxAmount,
        total: settlement.sellerGrossAmount,
        items: [
          {
            description: order.productName,
            amount: settlement.sellerGrossAmount,
            taxAmount: settlement.taxAmount,
            quantity: settlement.quantity,
          },
        ],
      }),
    );
  }
  return invoices;
}

module.exports = { ensureOrderInvoice, issueOrderInvoices };

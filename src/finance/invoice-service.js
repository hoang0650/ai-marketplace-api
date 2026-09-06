const crypto = require('crypto');
const Invoice = require('../models/Invoice');

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

module.exports = { issueOrderInvoices };

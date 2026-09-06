const crypto = require('crypto');
const LedgerEntry = require('../models/LedgerEntry');

function newEntryId(prefix = 'led') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Record immutable marketplace ledger lines for an order.
 * Internal entitlement only — not a licensed payment account balance.
 */
async function recordOrderLedger({
  order,
  ownershipType,
  sellerNet,
  platformFee,
  amount,
  currency,
}) {
  const base = {
    orderId: order._id,
    sellerId: order.seller,
    buyerId: order.buyer,
    productId: order.product,
    currency: currency || order.currency || 'USD',
    ownershipType,
  };

  const lines = [
    {
      ...base,
      entryId: newEntryId('gross'),
      type: 'ORDER_GROSS',
      amount,
      direction: 'credit',
      reference: `order:${order._id}`,
    },
    {
      ...base,
      entryId: newEntryId('fee'),
      type: 'PLATFORM_FEE',
      amount: platformFee,
      direction: 'credit',
      reference: `order:${order._id}:platform-fee`,
    },
  ];

  if (ownershipType === 'THIRD_PARTY_SELLER' && sellerNet > 0) {
    lines.push({
      ...base,
      entryId: newEntryId('ent'),
      type: 'SELLER_ENTITLEMENT',
      amount: sellerNet,
      direction: 'credit',
      reference: `order:${order._id}:seller-entitlement`,
    });
  }

  await LedgerEntry.insertMany(lines);
  return lines;
}

module.exports = { recordOrderLedger, newEntryId };

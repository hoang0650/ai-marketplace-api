const mongoose = require('mongoose');

/**
 * Immutable financial ledger for marketplace entitlement / reconciliation.
 * NOT a licensed e-wallet or bank deposit account.
 */
const ledgerEntrySchema = new mongoose.Schema(
  {
    entryId: { type: String, required: true, unique: true, index: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    type: {
      type: String,
      enum: [
        'CUSTOMER_PAYMENT',
        'ORDER_GROSS',
        'PLATFORM_REVENUE',
        'PLATFORM_FEE',
        'SELLER_PAYABLE',
        'SELLER_ENTITLEMENT',
        'TAX_PAYABLE',
        'PAYMENT_PROCESSING_FEE',
        'STORE_FEE',
        'PROVIDER_COST',
        'REFUND',
        'REFUND_PAYABLE',
        'CHARGEBACK',
        'TAX',
        'ADJUSTMENT',
      ],
      required: true,
      index: true,
    },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'VND' },
    direction: { type: String, enum: ['debit', 'credit'], required: true },
    ownershipType: {
      type: String,
      enum: ['PLATFORM_DIRECT', 'THIRD_PARTY_SELLER'],
      default: 'THIRD_PARTY_SELLER',
    },
    reference: { type: String, default: '' },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'financial_ledger' }
);

ledgerEntrySchema.index({ createdAt: -1 });

module.exports = mongoose.model('LedgerEntry', ledgerEntrySchema);

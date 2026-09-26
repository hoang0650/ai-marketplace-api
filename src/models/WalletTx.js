const mongoose = require('mongoose');

const walletTxSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['credit', 'debit', 'withdraw', 'deposit'], required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    note: { type: String, default: '' },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'cancelled'],
      default: 'completed',
      index: true,
    },
    payoutId: { type: String, default: '', index: true },
    paymentMethod: { type: String, enum: ['', 'sepay', 'paypal', 'iap', 'apple_pay', 'google_pay', 'gpay'], default: '' },
    paypalOrderId: { type: String, default: '', index: true },
    /** GPay transaction reference (gateway / QR / Virtual Account). */
    gpayTransactionId: { type: String, default: '' },
    gpayAccountNumber: { type: String, default: '' },
    /** Our GPay order id (`AIM…`): gateway request_id / QR bill_id. */
    gpayRequestId: { type: String, default: '' },
    /** GPay gateway bill id (for bill-info reconciliation). */
    gpayBillId: { type: String, default: '' },
    iapTransactionId: { type: String, index: true },
    iapProductId: { type: String, default: '' },
    paypalPayerId: { type: String, default: '' },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewNote: { type: String, default: '', maxlength: 500 },
    /** Structured usage / billing metadata (e.g. OpenClaw tokens). */
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
walletTxSchema.index({ type: 1, status: 1, createdAt: -1 });
walletTxSchema.index({ user: 1, 'meta.channel': 1, createdAt: -1 });
walletTxSchema.index({ iapTransactionId: 1 }, { unique: true, sparse: true });
/** One GPay deposit row per GPay transaction (idempotent webhooks). */
walletTxSchema.index(
  { gpayTransactionId: 1 },
  { unique: true, partialFilterExpression: { gpayTransactionId: { $gt: '' } } }
);
walletTxSchema.index(
  { gpayRequestId: 1 },
  { unique: true, partialFilterExpression: { gpayRequestId: { $gt: '' } } }
);

walletTxSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

walletTxSchema.set('toJSON', { virtuals: true });
walletTxSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('WalletTx', walletTxSchema);

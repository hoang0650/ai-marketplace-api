const mongoose = require('mongoose');

const sellerPayoutSchema = new mongoose.Schema(
  {
    payoutId: { type: String, required: true, unique: true, index: true },
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    orderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }],
    payableAmount: { type: Number, required: true },
    taxAmount: { type: Number, default: 0 },
    commissionAmount: { type: Number, default: 0 },
    paymentFee: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' },
    status: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED', 'ON_HOLD'],
      default: 'PENDING',
      index: true,
    },
    holdReason: { type: String, default: '', maxlength: 500 },
    paidAt: { type: Date, default: null },
    idempotencyKey: { type: String, default: '', index: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: 'seller_payouts' }
);

sellerPayoutSchema.index({ sellerId: 1, createdAt: -1 });

module.exports = mongoose.model('SellerPayout', sellerPayoutSchema);

const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, required: true },
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    buyerName: { type: String, required: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    quantity: { type: Number, default: 1, min: 1, max: 99 },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    sellerNet: { type: Number, default: 0, min: 0 },
    platformFee: { type: Number, default: 0, min: 0 },
    completedAt: { type: Date, default: null },
    payoutHoldUntil: { type: Date, default: null },
    disputeStatus: {
      type: String,
      enum: ['none', 'open', 'seller_win', 'buyer_win'],
      default: 'none',
      index: true,
    },
    disputeReason: { type: String, default: '', maxlength: 1000 },
    disputeOpenedAt: { type: Date, default: null },
    disputeResolvedAt: { type: Date, default: null },
    disputeResolutionNote: { type: String, default: '', maxlength: 1000 },
    status: { type: String, enum: ['pending', 'paid', 'refunded'], default: 'pending' },
    provider: {
      type: String,
      enum: ['wallet', 'stripe', 'paypal', 'paddle', 'payos'],
      default: 'wallet',
      required: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

// Hot paths: buyer order history, seller sales dashboard (both sorted by newest).
orderSchema.index({ buyer: 1, createdAt: -1 });
orderSchema.index({ seller: 1, createdAt: -1 });
orderSchema.index({ seller: 1, status: 1, disputeStatus: 1 });
orderSchema.index({ product: 1, status: 1 });

orderSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

orderSchema.set('toJSON', { virtuals: true });
orderSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Order', orderSchema);

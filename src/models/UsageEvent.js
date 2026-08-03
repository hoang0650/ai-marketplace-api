const mongoose = require('mongoose');

/**
 * One metered invocation of a deployment. This is the billing source of truth:
 * cost = buyer charge, sellerNet = creator payout, platformFee = take rate.
 */
const usageEventSchema = new mongoose.Schema(
  {
    deployment: { type: mongoose.Schema.Types.ObjectId, ref: 'Deployment', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    inputTokens: { type: Number, required: true, min: 0 },
    outputTokens: { type: Number, required: true, min: 0 },
    /** USD, rounded to 6 decimals (micro-billing) */
    cost: { type: Number, required: true, min: 0 },
    platformFee: { type: Number, required: true, min: 0 },
    sellerNet: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

usageEventSchema.index({ deployment: 1, createdAt: -1 });
usageEventSchema.index({ buyer: 1, createdAt: -1 });
usageEventSchema.index({ seller: 1, createdAt: -1 });

usageEventSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});
usageEventSchema.set('toJSON', { virtuals: true });
usageEventSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('UsageEvent', usageEventSchema);

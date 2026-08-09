const mongoose = require('mongoose');

/**
 * One metered invocation (deployment invoke or playground run).
 * Billing source of truth: cost / sellerNet / platformFee.
 */
const usageEventSchema = new mongoose.Schema(
  {
    deployment: { type: mongoose.Schema.Types.ObjectId, ref: 'Deployment', default: null },
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
    /** AI router provider id */
    provider: { type: String, default: '', trim: true },
    /** tokens | seconds | images | requests */
    unit: { type: String, default: 'tokens' },
    quantity: { type: Number, default: 0, min: 0 },
    rawUsage: { type: mongoose.Schema.Types.Mixed, default: null },
    source: { type: String, enum: ['deployment', 'playground', 'api'], default: 'deployment' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

usageEventSchema.index({ deployment: 1, createdAt: -1 });
usageEventSchema.index({ product: 1, createdAt: -1 });
usageEventSchema.index({ buyer: 1, createdAt: -1 });
usageEventSchema.index({ seller: 1, createdAt: -1 });

usageEventSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});
usageEventSchema.set('toJSON', { virtuals: true });
usageEventSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('UsageEvent', usageEventSchema);

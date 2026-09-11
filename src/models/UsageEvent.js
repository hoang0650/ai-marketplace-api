const crypto = require('crypto');
const mongoose = require('mongoose');

function newUsageIdempotencyKey(source = 'evt') {
  return `ue_${String(source || 'evt').slice(0, 12)}_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * One metered invocation (deployment invoke or playground run).
 * Billing source of truth: cost / sellerNet / platformFee.
 *
 * `idempotencyKey` is unique. Never default it to null — Mongo unique indexes
 * treat null as a real value, so a second playground TTS would 409.
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
    source: { type: String, enum: ['deployment', 'playground', 'api', 'gateway', 'training', 'gpu'], default: 'deployment' },
    usageType: { type: String, default: 'API_REQUEST', index: true },
    idempotencyKey: { type: String, sparse: true, unique: true, trim: true, maxlength: 160 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

usageEventSchema.index({ deployment: 1, createdAt: -1 });
usageEventSchema.index({ product: 1, createdAt: -1 });
usageEventSchema.index({ buyer: 1, createdAt: -1 });
usageEventSchema.index({ seller: 1, createdAt: -1 });

usageEventSchema.pre('validate', function assignIdempotencyKey() {
  const key = String(this.idempotencyKey || '').trim();
  this.idempotencyKey = key || newUsageIdempotencyKey(this.source);
});

usageEventSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});
usageEventSchema.set('toJSON', { virtuals: true });
usageEventSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('UsageEvent', usageEventSchema);
module.exports.newUsageIdempotencyKey = newUsageIdempotencyKey;

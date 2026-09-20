const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema(
  {
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    code: { type: String, required: true, uppercase: true, trim: true, maxlength: 24 },
    type: { type: String, enum: ['percent', 'amount'], required: true },
    value: { type: Number, required: true, min: 0 },
    /** Empty = every listing owned by this seller. */
    productIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    minSubtotal: { type: Number, default: 0, min: 0 },
    maxDiscount: { type: Number, default: 0, min: 0 },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    maxUses: { type: Number, default: 0, min: 0 },
    maxUsesPerBuyer: { type: Number, default: 1, min: 0 },
    usedCount: { type: Number, default: 0, min: 0 },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

couponSchema.index({ seller: 1, code: 1 }, { unique: true });

couponSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

couponSchema.set('toJSON', { virtuals: true });
couponSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Coupon', couponSchema);

const mongoose = require('mongoose');

const couponRedemptionSchema = new mongoose.Schema(
  {
    coupon: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', required: true, index: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    code: { type: String, default: '', uppercase: true },
    discount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

couponRedemptionSchema.index({ coupon: 1, buyer: 1 });

module.exports = mongoose.model('CouponRedemption', couponRedemptionSchema);

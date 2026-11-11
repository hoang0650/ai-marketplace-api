const mongoose = require('mongoose');

const usageEntitlementSchema = new mongoose.Schema(
  {
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    unit: { type: String, required: true },
    period: { type: String, enum: ['day', 'week', 'month', 'year'], required: true },
    startsAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true, index: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active', index: true },
  },
  { timestamps: true }
);

usageEntitlementSchema.index({ buyer: 1, product: 1, expiresAt: -1 });

module.exports = mongoose.model('UsageEntitlement', usageEntitlementSchema);

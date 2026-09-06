const mongoose = require('mongoose');

const commissionRuleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    rate: { type: Number, required: true, min: 0, max: 1 },
    appliesTo: {
      type: String,
      enum: ['THIRD_PARTY_SELLER', 'PLATFORM', 'ALL'],
      default: 'THIRD_PARTY_SELLER',
      index: true,
    },
    categories: { type: [String], default: [] },
    sellerTypes: { type: [String], default: [] },
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    minAmount: { type: Number, default: null },
    maxAmount: { type: Number, default: null },
    effectiveFrom: { type: Date, default: Date.now },
    effectiveTo: { type: Date, default: null },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
    currency: { type: String, default: '' },
  },
  { timestamps: true, collection: 'commission_rules' }
);

commissionRuleSchema.index({ status: 1, appliesTo: 1, effectiveFrom: 1 });

module.exports = mongoose.model('CommissionRule', commissionRuleSchema);

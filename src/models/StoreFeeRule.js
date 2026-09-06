const mongoose = require('mongoose');

const storeFeeRuleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    salesChannel: {
      type: String,
      enum: ['WEB', 'GOOGLE_PLAY', 'APP_STORE'],
      required: true,
      index: true,
    },
    rate: { type: Number, required: true, min: 0, max: 1 },
    collector: { type: String, enum: ['', 'GOOGLE', 'APPLE'], default: '' },
    effectiveFrom: { type: Date, default: Date.now },
    effectiveTo: { type: Date, default: null },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
    notes: { type: String, default: '', maxlength: 1000 },
  },
  { timestamps: true, collection: 'store_fee_rules' }
);

storeFeeRuleSchema.index({ status: 1, salesChannel: 1, effectiveFrom: 1 });

module.exports = mongoose.model('StoreFeeRule', storeFeeRuleSchema);

const mongoose = require('mongoose');

const taxWithholdingSchema = new mongoose.Schema(
  {
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    taxType: { type: String, required: true },
    taxableAmount: { type: Number, required: true },
    withheldAmount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    status: {
      type: String,
      enum: ['PENDING', 'WITHHELD', 'REMITTED', 'ADJUSTED', 'REFUNDED'],
      default: 'WITHHELD',
      index: true,
    },
    taxPeriod: { type: String, default: '' },
  },
  { timestamps: true, collection: 'tax_withholdings' }
);

taxWithholdingSchema.index({ sellerId: 1, taxPeriod: 1 });

module.exports = mongoose.model('TaxWithholding', taxWithholdingSchema);

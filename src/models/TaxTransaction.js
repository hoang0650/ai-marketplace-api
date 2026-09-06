const mongoose = require('mongoose');

const taxTransactionSchema = new mongoose.Schema(
  {
    taxTransactionId: { type: String, required: true, unique: true, index: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    orderItemId: { type: String, default: '' },
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    taxType: { type: String, required: true },
    taxRate: { type: Number, required: true },
    taxableAmount: { type: Number, required: true },
    taxAmount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    jurisdiction: { type: String, default: '' },
    taxPeriod: { type: String, default: '' },
    status: {
      type: String,
      enum: ['PENDING', 'FINALIZED', 'ADJUSTMENT'],
      default: 'FINALIZED',
      index: true,
    },
    kind: { type: String, enum: ['ORIGINAL', 'ADJUSTMENT'], default: 'ORIGINAL' },
    adjustsId: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'tax_transactions' }
);

module.exports = mongoose.model('TaxTransaction', taxTransactionSchema);

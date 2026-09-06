const mongoose = require('mongoose');

const refundSchema = new mongoose.Schema(
  {
    refundId: { type: String, required: true, unique: true, index: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD' },
    reason: { type: String, default: '', maxlength: 1000 },
    status: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'PROCESSED', 'FAILED', 'CANCELLED'],
      default: 'PENDING',
      index: true,
    },
    settlement: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'refunds' }
);

module.exports = mongoose.model('Refund', refundSchema);

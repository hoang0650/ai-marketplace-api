const mongoose = require('mongoose');

const chargebackSchema = new mongoose.Schema(
  {
    chargebackId: { type: String, required: true, unique: true, index: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    feeAmount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'USD' },
    reason: { type: String, default: '', maxlength: 1000 },
    status: {
      type: String,
      enum: ['OPEN', 'WON', 'LOST', 'ADJUSTED'],
      default: 'OPEN',
      index: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'chargebacks' }
);

module.exports = mongoose.model('Chargeback', chargebackSchema);

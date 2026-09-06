const mongoose = require('mongoose');

/** Idempotent payment / refund / payout provider events. */
const paymentEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    provider: { type: String, required: true, index: true },
    kind: {
      type: String,
      enum: ['payment', 'refund', 'chargeback', 'payout', 'webhook'],
      required: true,
    },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
    payloadHash: { type: String, default: '' },
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'payment_events' }
);

module.exports = mongoose.model('PaymentEvent', paymentEventSchema);

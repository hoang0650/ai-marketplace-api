const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, required: true },
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    buyerName: { type: String, required: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    status: { type: String, enum: ['pending', 'paid', 'refunded'], default: 'pending' },
    provider: { type: String, enum: ['stripe', 'paypal', 'paddle', 'payos'], required: true },
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

// Hot paths: buyer order history, seller sales dashboard (both sorted by newest).
orderSchema.index({ buyer: 1, createdAt: -1 });
orderSchema.index({ seller: 1, createdAt: -1 });

orderSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

orderSchema.set('toJSON', { virtuals: true });
orderSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Order', orderSchema);

const mongoose = require('mongoose');

const invoiceItemSchema = new mongoose.Schema(
  {
    description: { type: String, default: '' },
    amount: { type: Number, required: true },
    taxAmount: { type: Number, default: 0 },
    quantity: { type: Number, default: 1 },
  },
  { _id: true }
);

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, unique: true, index: true },
    kind: {
      type: String,
      enum: ['PLATFORM_INVOICE', 'SELLER_INVOICE'],
      required: true,
      index: true,
    },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    currency: { type: String, default: 'USD' },
    subtotal: { type: Number, required: true },
    taxAmount: { type: Number, default: 0 },
    total: { type: Number, required: true },
    items: { type: [invoiceItemSchema], default: [] },
    status: { type: String, enum: ['DRAFT', 'ISSUED', 'VOID'], default: 'ISSUED' },
  },
  { timestamps: true, collection: 'invoices' }
);

module.exports = mongoose.model('Invoice', invoiceSchema);

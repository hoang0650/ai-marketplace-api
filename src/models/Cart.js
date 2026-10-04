const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    qty: { type: Number, default: 1, min: 1, max: 99 },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/** Server-side cart (separate from User.wishlist) so web + app share the same lines. */
const cartSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    items: { type: [cartItemSchema], default: [] },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Cart', cartSchema);

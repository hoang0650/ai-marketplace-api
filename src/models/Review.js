const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    userName: { type: String, required: true },
    rating: { type: Number, min: 1, max: 5, required: true },
    title: { type: String, default: '' },
    body: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

reviewSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

reviewSchema.set('toJSON', { virtuals: true });
reviewSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Review', reviewSchema);

const mongoose = require('mongoose');

/** One referral-link visit. Used for last-click attribution inside the configured window. */
const affiliateClickSchema = new mongoose.Schema(
  {
    affiliate: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    code: { type: String, required: true, trim: true, index: true },
    /** Scope: a product link, or a store link (any product of that seller). */
    scope: { type: String, enum: ['product', 'store'], required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null, index: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Set when the visitor was signed in (server-side last click across devices). */
    visitor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    ipHash: { type: String, default: '' },
    userAgent: { type: String, default: '', maxlength: 300 },
    landing: { type: String, default: '', maxlength: 500 },
  },
  { timestamps: true },
);

affiliateClickSchema.index({ visitor: 1, createdAt: -1 });

module.exports = mongoose.model('AffiliateClick', affiliateClickSchema);

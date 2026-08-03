const mongoose = require('mongoose');
const { PRODUCT_CATEGORIES } = require('../data/categories');

const pricingSchema = new mongoose.Schema(
  {
    model: { type: String, enum: ['free', 'one-time', 'subscription', 'usage'], required: true },
    price: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' },
    interval: { type: String, enum: ['month', 'year', null], default: null },
    usageUnit: { type: String },
    usageRate: { type: Number },
  },
  { _id: false }
);

const changelogSchema = new mongoose.Schema(
  {
    version: String,
    date: String,
    notes: String,
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    tagline: { type: String, default: '' },
    description: { type: String, default: '' },
    category: { type: String, enum: PRODUCT_CATEGORIES, required: true },
    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    creatorSlug: { type: String, required: true, index: true },
    creatorName: { type: String, required: true },
    coverUrl: { type: String, default: '' },
    gallery: { type: [String], default: [] },
    pricing: { type: pricingSchema, required: true },
    rating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
    installCount: { type: Number, default: 0 },
    tags: { type: [String], default: [] },
    apiDocsMarkdown: { type: String, default: '' },
    changelog: { type: [changelogSchema], default: [] },
    featured: { type: Boolean, default: false },
    publishedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

productSchema.index({ name: 'text', tagline: 'text', description: 'text', tags: 'text' });

productSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Product', productSchema);

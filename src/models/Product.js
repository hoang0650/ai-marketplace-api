const mongoose = require('mongoose');
const { PRODUCT_CATEGORIES } = require('../data/categories');

const pricingSchema = new mongoose.Schema(
  {
    model: { type: String, enum: ['free', 'one-time', 'subscription', 'usage'], required: true },
    price: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' },
    interval: { type: String, enum: ['day', 'month', 'year', null], default: null },
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

const envVarSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 128 },
    value: { type: String, default: '', maxlength: 4000 },
  },
  { _id: false }
);

/** Seller RunPod / gateway runtime attached to the catalog product. */
const runtimeSchema = new mongoose.Schema(
  {
    serverlessEndpoint: { type: String, default: '', trim: true, maxlength: 500 },
    tokenizeEndpoint: { type: String, default: '', trim: true, maxlength: 500 },
    gatewayUrl: { type: String, default: '', trim: true, maxlength: 500 },
    publicEndpoint: { type: String, default: '', trim: true, maxlength: 500 },
    env: { type: [envVarSchema], default: [] },
    skills: { type: [String], default: [] },
    baseModel: { type: String, default: '', trim: true, maxlength: 200 },
    systemPrompt: { type: String, default: '', maxlength: 4000 },
    temperature: { type: Number, default: 0.7, min: 0, max: 2 },
    maxTokens: { type: Number, default: 1024, min: 1, max: 32768 },
  },
  { _id: false }
);

const contentMetaSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['voice', 'series', 'story', 'skill', 'dataset', ''], default: '' },
    voiceModes: { type: [String], default: [] },
    voiceSampleUrl: { type: String, default: '', maxlength: 500 },
    creditUnit: { type: String, enum: ['character', 'word', ''], default: '' },
    charactersPerCredit: { type: Number, default: 1000, min: 1 },
    episodeCount: { type: Number, default: 0, min: 0 },
    licenseTerm: { type: String, enum: ['day', 'month', 'year', ''], default: '' },
    licensePrices: {
      day: { type: Number, default: 0, min: 0 },
      month: { type: Number, default: 0, min: 0 },
      year: { type: Number, default: 0, min: 0 },
    },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    tagline: { type: String, default: '' },
    description: { type: String, default: '' },
    category: { type: String, enum: [...PRODUCT_CATEGORIES, 'openrouter', 'featherless', 'runpod-public'], required: true },
    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    creatorSlug: { type: String, required: true, index: true },
    creatorName: { type: String, required: true },
    /** PLATFORM_DIRECT = sold by marketplace operator; THIRD_PARTY_SELLER = third-party seller. */
    ownershipType: {
      type: String,
      enum: ['PLATFORM_DIRECT', 'THIRD_PARTY_SELLER'],
      default: 'THIRD_PARTY_SELLER',
      index: true,
    },
    /** Infra backend only (runpod, openrouter, …). Never treat as marketplace seller. */
    infraProvider: { type: String, default: '', trim: true, index: true },
    license: { type: String, default: '', maxlength: 500 },
    termsSummary: { type: String, default: '', maxlength: 2000 },
    complianceStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'restricted'],
      default: 'pending',
      index: true,
    },
    coverUrl: { type: String, default: '' },
    gallery: { type: [String], default: [] },
    pricing: { type: pricingSchema, required: true },
    runtime: { type: runtimeSchema, default: () => ({}) },
    contentMeta: { type: contentMetaSchema, default: () => ({}) },
    rating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
    installCount: { type: Number, default: 0 },
    /** Units sold from paid orders (denormalized; source of truth is Order). */
    salesCount: { type: Number, default: 0, index: true, min: 0 },
    tags: { type: [String], default: [] },
    apiDocsMarkdown: { type: String, default: '' },
    changelog: { type: [changelogSchema], default: [] },
    featured: { type: Boolean, default: false },
    publishedAt: { type: Date, default: Date.now },
    productType: { type: String, default: 'MODEL', index: true },
    taxCategory: { type: String, default: '', trim: true, uppercase: true, index: true },
    /** @deprecated Prefer infraProvider — kept for backward compatibility with catalog seeds. */
    provider: { type: String, default: '', trim: true, index: true },
    published: { type: Boolean, default: true, index: true },
    moderationStatus: {
      type: String,
      enum: ['active', 'suspended', 'blocked', 'inactive', 'pending_review'],
      default: 'active',
      index: true,
    },
    suspendedUntil: { type: Date, default: null },
    statusReason: { type: String, default: '', maxlength: 500 },
    statusChangedAt: { type: Date, default: null },
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

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
    /** Optional separate per-unit prices for prompt (input) and completion (output) tokens. */
    inputRate: { type: Number },
    outputRate: { type: Number },
    /** 'upstream': bill provider-reported cost × (1 + markup); usageRate is the listed "from" price. */
    costBasis: { type: String },
    /** List price before sale. When > price, listing shows as discounted. */
    compareAtPrice: { type: Number, default: 0, min: 0 },
    /** Hire listings: `price` is the starting quote and the buyer may counter-offer. */
    negotiable: { type: Boolean, default: true },
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

/** GPU / game stream listings (gpu-compute, game-server). */
const streamingSchema = new mongoose.Schema(
  {
    /** Buyer clients served: pc = web/desktop, mobile = Android/iOS app. Synced from linked nodes. */
    devices: { type: [{ type: String, enum: ['pc', 'mobile'] }], default: () => ['pc', 'mobile'] },
    /** PLATFORM_DIRECT GPU listing rented as a platform workspace (/gpu) with this GPU offer id. */
    rentalOfferId: { type: String, default: '', trim: true, maxlength: 120 },
  },
  { _id: false }
);

const contentMetaSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['voice', 'series', 'story', 'skill', 'dataset', ''], default: '' },
    /** clone = seller MP3; preset = platform VieNeu voice */
    voiceSource: { type: String, enum: ['', 'clone', 'preset'], default: '' },
    voiceModes: { type: [String], default: [] },
    voiceSampleUrl: { type: String, default: '', maxlength: 500 },
    presetVoiceId: { type: String, default: '', maxlength: 64 },
    presetVoiceName: { type: String, default: '', maxlength: 120 },
    cloneStatus: {
      type: String,
      enum: ['', 'pending', 'ready', 'failed'],
      default: '',
    },
    cloneProvider: { type: String, default: '', maxlength: 64 },
    cloneEndpoint: { type: String, default: '', maxlength: 128 },
    cloneError: { type: String, default: '', maxlength: 500 },
    cloneReadyAt: { type: String, default: '' },
    creditUnit: { type: String, enum: ['character', 'word', ''], default: '' },
    charactersPerCredit: { type: Number, default: 1000, min: 1 },
    episodeCount: { type: Number, default: 0, min: 0 },
    /** Series player: overall synopsis and genre chips. */
    synopsis: { type: String, default: '', maxlength: 4000 },
    genres: { type: [String], default: [] },
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
    /** Real sample outputs shown on the product page: [{kind, url, posterUrl, text, prompt, inputImageUrl, settings}]. */
    demos: {
      type: [
        new mongoose.Schema(
          {
            kind: { type: String, enum: ['image', 'video', 'audio', 'text'], required: true },
            url: { type: String, default: '' },
            posterUrl: { type: String, default: '' },
            text: { type: String, default: '' },
            prompt: { type: String, default: '' },
            inputImageUrl: { type: String, default: '' },
            settings: { type: String, default: '' },
            createdAt: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    pricing: { type: pricingSchema, required: true },
    /** Professional services: optional phase plan [{title, percent, days}] (percent sums to 100). */
    servicePlan: {
      type: [new mongoose.Schema({ title: String, percent: Number, days: Number }, { _id: false })],
      default: undefined,
    },
    /** Affiliate commission 0–0.25 of the price after discount, paid by the seller. null = store default. */
    affiliateRate: { type: Number, default: null, min: 0, max: 0.25 },
    runtime: { type: runtimeSchema, default: () => ({}) },
    streaming: { type: streamingSchema, default: () => ({}) },
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
    /**
     * Required seller declaration: DIGITAL (sản phẩm số / dịch vụ) or PHYSICAL (hàng hóa vật lý).
     * Drives the withheld tax rate for individual sellers (NĐ 252/2026, TT 18/2026): digital 5% GTGT + 2% TNCN,
     * goods 1% GTGT + 0.5% TNCN. Legacy rows are defaulted to DIGITAL by ensureProductKinds().
     */
    productKind: { type: String, enum: ['DIGITAL', 'PHYSICAL', ''], default: '', index: true },
    productKindDefaultedAt: { type: Date, default: null },
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

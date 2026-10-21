const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, required: true },
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    buyerName: { type: String, required: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    ownershipType: {
      type: String,
      enum: ['PLATFORM_DIRECT', 'THIRD_PARTY_SELLER'],
      default: 'THIRD_PARTY_SELLER',
      index: true,
    },
    quantity: { type: Number, default: 1, min: 1, max: 99 },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    unitPrice: { type: Number, default: 0, min: 0 },
    listUnitPrice: { type: Number, default: 0, min: 0 },
    couponCode: { type: String, default: '', uppercase: true, trim: true },
    couponDiscount: { type: Number, default: 0, min: 0 },
    couponId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', default: null },
    grossAmount: { type: Number, default: 0, min: 0 },
    commissionRate: { type: Number, default: null },
    commissionAmount: { type: Number, default: 0, min: 0 },
    commissionRuleId: { type: mongoose.Schema.Types.Mixed, default: null },
    taxAmount: { type: Number, default: 0, min: 0 },
    taxBreakdown: { type: mongoose.Schema.Types.Mixed, default: [] },
    taxCategory: { type: String, default: '' },
    /** Tax policy 2026-10 snapshot: seller type at order time + rates/amounts (never recomputed). */
    sellerType: { type: String, default: '', index: true },
    taxPolicy: { type: mongoose.Schema.Types.Mixed, default: null },
    /** Company sellers: the platform issues a 10% VAT invoice for its fee. */
    platformFeeInvoice: { type: mongoose.Schema.Types.Mixed, default: null },
    paymentFeeAmount: { type: Number, default: 0, min: 0 },
    salesChannel: {
      type: String,
      enum: ['WEB', 'GOOGLE_PLAY', 'APP_STORE'],
      default: 'WEB',
      index: true,
    },
    storeFeeRate: { type: Number, default: 0, min: 0, max: 1 },
    storeFeeAmount: { type: Number, default: 0, min: 0 },
    storeFeeCollector: { type: String, enum: ['', 'GOOGLE', 'APPLE'], default: '' },
    refundAmount: { type: Number, default: 0, min: 0 },
    chargebackAmount: { type: Number, default: 0, min: 0 },
    sellerGrossAmount: { type: Number, default: 0, min: 0 },
    sellerNetAmount: { type: Number, default: 0, min: 0 },
    platformRevenueAmount: { type: Number, default: 0, min: 0 },
    /** Affiliate snapshot (rate at order time; amount is deducted from sellerNetAmount). */
    affiliateRate: { type: Number, default: 0, min: 0, max: 0.25 },
    affiliateCommissionAmount: { type: Number, default: 0, min: 0 },
    affiliateUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    affiliateCode: { type: String, default: '' },
    affiliateClick: { type: mongoose.Schema.Types.ObjectId, ref: 'AffiliateClick', default: null },
    /** @deprecated Alias of sellerNetAmount (snapshot). Do not recompute from current rate. */
    sellerNet: { type: Number, default: 0, min: 0 },
    /** @deprecated Alias of platformRevenueAmount. */
    platformFee: { type: Number, default: 0, min: 0 },
    financialSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    completedAt: { type: Date, default: null },
    payoutHoldUntil: { type: Date, default: null },
    /** Immutable snapshot at purchase time for contract/history. */
    contractSnapshot: {
      productName: { type: String, default: '' },
      productDescription: { type: String, default: '' },
      sellerDisplayName: { type: String, default: '' },
      sellerLegalName: { type: String, default: '' },
      ownershipType: { type: String, default: '' },
      pricing: { type: mongoose.Schema.Types.Mixed, default: null },
      license: { type: String, default: '' },
      termsSummary: { type: String, default: '' },
      refundPolicyVersion: { type: String, default: '' },
      termsVersion: { type: String, default: '' },
      infraProvider: { type: String, default: '' },
    },
    /** Set when the order pays one phase of a quoted hire project. */
    hireProject: { type: mongoose.Schema.Types.ObjectId, ref: 'HireProject', default: null, index: true },
    hireMilestone: { type: Number, default: null },
    /** Client Idempotency-Key of the checkout click (unique per buyer): a retried request never charges twice. */
    idempotencyKey: { type: String, default: undefined, trim: true, maxlength: 120 },
    disputeStatus: {
      type: String,
      enum: ['none', 'open', 'seller_win', 'buyer_win'],
      default: 'none',
      index: true,
    },
    disputeReason: { type: String, default: '', maxlength: 1000 },
    disputeOpenedAt: { type: Date, default: null },
    disputeResolvedAt: { type: Date, default: null },
    disputeResolutionNote: { type: String, default: '', maxlength: 1000 },
    status: { type: String, enum: ['pending', 'paid', 'refunded'], default: 'pending' },
    fulfillmentStatus: {
      type: String,
      enum: ['pending', 'fulfilled', 'failed', 'cancelled'],
      default: 'pending',
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    /** Payment rail — NOT infra provider. */
    paymentProvider: {
      type: String,
      enum: ['wallet', 'paypal', 'paddle', 'payos', 'internal_ledger'],
      default: 'wallet',
    },
    /** @deprecated Alias of paymentProvider (historical field name). */
    provider: {
      type: String,
      enum: ['wallet', 'paypal', 'paddle', 'payos', 'internal_ledger'],
      default: 'wallet',
      required: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

// Hot paths: buyer order history, seller sales dashboard (both sorted by newest).
orderSchema.index({ buyer: 1, createdAt: -1 });
orderSchema.index({ seller: 1, createdAt: -1 });
orderSchema.index({ seller: 1, status: 1, disputeStatus: 1 });
orderSchema.index({ product: 1, status: 1 });
orderSchema.index(
  { buyer: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

orderSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

orderSchema.set('toJSON', { virtuals: true });
orderSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Order', orderSchema);

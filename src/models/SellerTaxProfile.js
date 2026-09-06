const mongoose = require('mongoose');
const { SELLER_TYPES } = require('../finance/seller-types');

const sellerTaxProfileSchema = new mongoose.Schema(
  {
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sellerType: { type: String, enum: SELLER_TYPES, required: true, default: 'INDIVIDUAL' },
    country: { type: String, default: 'VN', trim: true, uppercase: true, maxlength: 8 },
    taxResidency: { type: String, default: 'VN', trim: true, uppercase: true, maxlength: 8 },
    taxIdentificationNumber: { type: String, default: '', trim: true, maxlength: 50 },
    businessRegistrationNumber: { type: String, default: '', trim: true, maxlength: 100 },
    vatStatus: { type: String, default: '', trim: true, maxlength: 80 },
    taxMethod: { type: String, default: '', trim: true, maxlength: 80 },
    invoiceMethod: { type: String, default: '', trim: true, maxlength: 80 },
    withholdingRequired: { type: Boolean, default: false },
    taxClassification: { type: String, default: '', trim: true, maxlength: 80 },
    effectiveFrom: { type: Date, default: Date.now, index: true },
    effectiveTo: { type: Date, default: null, index: true },
    verificationStatus: {
      type: String,
      enum: ['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED'],
      default: 'PENDING',
    },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'seller_tax_profiles' }
);

sellerTaxProfileSchema.index({ sellerId: 1, effectiveTo: 1, version: -1 });

module.exports = mongoose.model('SellerTaxProfile', sellerTaxProfileSchema);

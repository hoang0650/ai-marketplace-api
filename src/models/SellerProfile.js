const mongoose = require('mongoose');

/**
 * Seller legal profile — separate from User account and from infra Provider.
 * Required for THIRD_PARTY_SELLER listings under VN e-commerce intermediary rules.
 */
const sellerProfileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    sellerType: {
      type: String,
      enum: [
        'individual',
        'household_business',
        'enterprise',
        'organization',
        'platform',
        'INDIVIDUAL',
        'HOUSEHOLD_BUSINESS',
        'COMPANY',
        'FOREIGN_INDIVIDUAL',
        'FOREIGN_COMPANY',
        'PLATFORM',
      ],
      default: 'individual',
    },
    legalName: { type: String, default: '', trim: true, maxlength: 300 },
    displayName: { type: String, default: '', trim: true, maxlength: 200 },
    taxCode: { type: String, default: '', trim: true, maxlength: 50 },
    businessRegistrationNumber: { type: String, default: '', trim: true, maxlength: 100 },
    businessAddress: { type: String, default: '', trim: true, maxlength: 500 },
    contactEmail: { type: String, default: '', trim: true, maxlength: 200 },
    contactPhone: { type: String, default: '', trim: true, maxlength: 40 },
    /** Store-wide affiliate commission (0–0.25); 0 = not in the program. Products may override. */
    affiliateDefaultRate: { type: Number, default: 0, min: 0, max: 0.25 },
    identityVerificationStatus: {
      type: String,
      enum: ['none', 'pending', 'verified', 'rejected'],
      default: 'none',
    },
    /** Bank metadata only — never store full account secrets plaintext for payouts. */
    bankAccountMetadata: {
      bankName: { type: String, default: '' },
      accountHolderName: { type: String, default: '' },
      accountNumberMasked: { type: String, default: '' },
    },
    verificationStatus: {
      type: String,
      enum: ['PENDING', 'VERIFICATION_REQUIRED', 'VERIFIED', 'SUSPENDED', 'REJECTED', 'TERMINATED'],
      default: 'PENDING',
      index: true,
    },
    complianceStatus: {
      type: String,
      enum: ['incomplete', 'under_review', 'compliant', 'non_compliant'],
      default: 'incomplete',
    },
    sellerAgreementVersion: { type: String, default: '' },
    sellerAgreementAcceptedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    suspendedAt: { type: Date, default: null },
    statusReason: { type: String, default: '', maxlength: 1000 },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'seller_profiles' }
);

sellerProfileSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

sellerProfileSchema.set('toJSON', { virtuals: true });
sellerProfileSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('SellerProfile', sellerProfileSchema);

const mongoose = require('mongoose');

const KYC_STATUSES = ['none', 'draft', 'pending', 'verified', 'rejected'];
const KYC_ID_TYPES = ['cccd', 'cmnd', 'passport', 'other'];
const KYC_SUBJECT_TYPES = ['individual', 'organization'];
const KYC_ORG_TYPES = ['household', 'company'];

const kycSchema = new mongoose.Schema(
  {
    status: { type: String, enum: KYC_STATUSES, default: 'none', index: true },
    subjectType: { type: String, enum: KYC_SUBJECT_TYPES, default: 'individual' },
    /** Individual: the person. Organization: its legal representative / household owner. */
    fullName: { type: String, default: '', trim: true, maxlength: 200 },
    idType: { type: String, enum: KYC_ID_TYPES, default: 'cccd' },
    idNumber: { type: String, default: '', trim: true, maxlength: 64 },
    personalTaxCode: { type: String, default: '', trim: true, maxlength: 20 },
    orgType: { type: String, enum: [...KYC_ORG_TYPES, ''], default: '' },
    orgName: { type: String, default: '', trim: true, maxlength: 300 },
    orgTaxCode: { type: String, default: '', trim: true, maxlength: 20 },
    orgAddress: { type: String, default: '', trim: true, maxlength: 500 },
    /** Stable KYC record id (kyc_<hex>) so admins can reference a record; set on first upload/submit or lazily by the admin queue. */
    recordId: { type: String, default: '', index: true },
    frontObjectName: { type: String, default: '' },
    frontFileName: { type: String, default: '', maxlength: 255 },
    frontFileSize: { type: Number, default: 0 },
    frontContentType: { type: String, default: '' },
    backObjectName: { type: String, default: '' },
    backFileName: { type: String, default: '', maxlength: 255 },
    backFileSize: { type: Number, default: 0 },
    backContentType: { type: String, default: '' },
    /** Organizations: business registration certificate / licence scan (household or company). */
    licenseObjectName: { type: String, default: '' },
    /** Business licence is a PDF (older uploads may be images). */
    licenseFileName: { type: String, default: '', maxlength: 255 },
    licenseFileSize: { type: Number, default: 0 },
    licenseContentType: { type: String, default: '' },
    submittedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectReason: { type: String, default: '', maxlength: 1000 },
  },
  { _id: false },
);

/**
 * Affiliate PIT commitment (Cam kết Mẫu 08/CK-TNCN, Thông tư 80/2021/TT-BTC): uploaded by the
 * affiliate, approved by an admin (same flow as eKYC). APPROVED for `year` = no 10% PIT withheld
 * on commissions paid in that year.
 */
const pitCommitmentSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ['none', 'draft', 'pending', 'approved', 'rejected'], default: 'none', index: true },
    year: { type: Number, default: null },
    objectName: { type: String, default: '' },
    contentType: { type: String, default: '' },
    personalTaxCode: { type: String, default: '', trim: true, maxlength: 20 },
    submittedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectReason: { type: String, default: '', maxlength: 1000 },
  },
  { _id: false },
);

const profileSchema = new mongoose.Schema(
  {
    introLine: { type: String, enum: ['', 'buyer', 'seller', 'builder', 'learner'], default: '' },
    region: { type: String, default: '', trim: true, maxlength: 120 },
    website: { type: String, default: '', trim: true, maxlength: 300 },
    notifyLang: { type: String, enum: ['vi', 'en', 'zh'], default: 'vi' },
    socials: {
      type: [
        new mongoose.Schema(
          {
            label: { type: String, default: '', trim: true, maxlength: 40 },
            url: { type: String, default: '', trim: true, maxlength: 300 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { _id: false },
);

const preferencesSchema = new mongoose.Schema(
  {
    personalizeContent: { type: Boolean, default: false },
    personalizeAds: { type: Boolean, default: false },
    /** Email a notice on each new sign-in (non-critical; user can unsubscribe). */
    emailLoginAlerts: { type: Boolean, default: true },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, default: '' },
    googleId: { type: String, trim: true, sparse: true, unique: true },
    authProvider: { type: String, enum: ['local', 'google'], default: 'local' },
    name: { type: String, required: true, trim: true },
    avatarUrl: { type: String, default: '' },
    /** buyer | seller | talent | freelancer | employer | admin — see utils/roles.js */
    role: { type: String, enum: ['buyer', 'seller', 'talent', 'freelancer', 'employer', 'admin'], default: 'buyer' },
    /** Least-privilege staff permissions (e.g. 'finance.tax' for kế toán thuế); admins need none. */
    adminPermissions: { type: [String], default: [] },
    creatorSlug: { type: String, trim: true, sparse: true, unique: true },
    bio: { type: String, default: '' },
    coverUrl: { type: String, default: '' },
    verified: { type: Boolean, default: false },
    wishlist: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    affiliateCode: { type: String, default: '' },
    affiliateClicks: { type: Number, default: 0 },
    affiliateConversions: { type: Number, default: 0 },
    affiliateEarnings: { type: Number, default: 0 },
    pitCommitment: { type: pitCommitmentSchema, default: () => ({}) },
    accountStatus: {
      type: String,
      enum: ['active', 'suspended', 'blocked', 'inactive', 'deleted'],
      default: 'active',
      index: true,
    },
    suspendedUntil: { type: Date, default: null },
    /** Self-service deletion: the document stays as an anonymised tombstone (see utils/account-deletion.js). */
    deletedAt: { type: Date, default: null },
    statusReason: { type: String, default: '', maxlength: 500 },
    statusChangedAt: { type: Date, default: null },
    /** Personal eKYC — required for withdraw (all roles except admin). */
    kyc: { type: kycSchema, default: () => ({}) },
    /** Saved VAT invoice details for reuse (order invoice choice). */
    invoiceProfile: {
      buyerType: { type: String, enum: ['', 'organization', 'individual'], default: '' },
      buyerName: { type: String, default: '', maxlength: 300 },
      taxCode: { type: String, default: '', maxlength: 20 },
      personalId: { type: String, default: '', maxlength: 20 },
      address: { type: String, default: '', maxlength: 500 },
      email: { type: String, default: '', maxlength: 200 },
      budgetUnitCode: { type: String, default: '', maxlength: 20 },
      updatedAt: { type: Date, default: null },
    },
    /** Own payout bank account (any eKYC-verified user; no seller profile needed). */
    payoutAccount: {
      bankName: { type: String, default: '', maxlength: 100 },
      accountNumber: { type: String, default: '', maxlength: 20 },
      accountName: { type: String, default: '', maxlength: 100 },
      updatedAt: { type: Date, default: null },
    },
    /** Public profile extras edited in /settings/profile. */
    profile: { type: profileSchema, default: () => ({}) },
    preferences: { type: preferencesSchema, default: () => ({}) },
    profileUpdatedAt: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
    /** sha256 of the single-use forgot-password token; never the token itself. */
    passwordResetTokenHash: { type: String, default: '', select: false },
    passwordResetExpires: { type: Date, default: null, select: false },
    /** Bumped to revoke every refresh token ("sign out everywhere", password change). */
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: true } },
);

userSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

userSchema.set('toJSON', { virtuals: true });
userSchema.set('toObject', { virtuals: true });

// Admin people tab: newest-first browsing, optionally by role.
userSchema.index({ createdAt: -1 });
userSchema.index({ role: 1, createdAt: -1 });

const User = mongoose.model('User', userSchema);
User.KYC_STATUSES = KYC_STATUSES;
User.KYC_ID_TYPES = KYC_ID_TYPES;
User.KYC_SUBJECT_TYPES = KYC_SUBJECT_TYPES;
User.KYC_ORG_TYPES = KYC_ORG_TYPES;
module.exports = User;

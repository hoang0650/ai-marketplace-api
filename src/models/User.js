const mongoose = require('mongoose');

const KYC_STATUSES = ['none', 'draft', 'pending', 'verified', 'rejected'];
const KYC_ID_TYPES = ['cccd', 'cmnd', 'passport', 'other'];

const kycSchema = new mongoose.Schema(
  {
    status: { type: String, enum: KYC_STATUSES, default: 'none', index: true },
    fullName: { type: String, default: '', trim: true, maxlength: 200 },
    idType: { type: String, enum: KYC_ID_TYPES, default: 'cccd' },
    idNumber: { type: String, default: '', trim: true, maxlength: 64 },
    frontObjectName: { type: String, default: '' },
    backObjectName: { type: String, default: '' },
    selfieObjectName: { type: String, default: '' },
    submittedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectReason: { type: String, default: '', maxlength: 1000 },
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
    creatorSlug: { type: String, trim: true, sparse: true, unique: true },
    bio: { type: String, default: '' },
    coverUrl: { type: String, default: '' },
    verified: { type: Boolean, default: false },
    wishlist: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    affiliateCode: { type: String, default: '' },
    affiliateClicks: { type: Number, default: 0 },
    affiliateConversions: { type: Number, default: 0 },
    affiliateEarnings: { type: Number, default: 0 },
    accountStatus: {
      type: String,
      enum: ['active', 'suspended', 'blocked', 'inactive'],
      default: 'active',
      index: true,
    },
    suspendedUntil: { type: Date, default: null },
    statusReason: { type: String, default: '', maxlength: 500 },
    statusChangedAt: { type: Date, default: null },
    /** Personal eKYC — required for withdraw (all roles except admin). */
    kyc: { type: kycSchema, default: () => ({}) },
  },
  { timestamps: { createdAt: true, updatedAt: true } },
);

userSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

userSchema.set('toJSON', { virtuals: true });
userSchema.set('toObject', { virtuals: true });

const User = mongoose.model('User', userSchema);
User.KYC_STATUSES = KYC_STATUSES;
User.KYC_ID_TYPES = KYC_ID_TYPES;
module.exports = User;

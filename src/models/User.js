const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    avatarUrl: { type: String, default: '' },
    role: { type: String, enum: ['buyer', 'creator', 'admin'], default: 'buyer' },
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
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

userSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

userSchema.set('toJSON', { virtuals: true });
userSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('User', userSchema);

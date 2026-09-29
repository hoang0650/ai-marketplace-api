const mongoose = require('mongoose');

/**
 * Buyer-owned AI provider key (BYOK) used by AI Markets OpenClaw.
 * `secret` holds the AES-GCM envelope from utils/secret-box and is never returned to clients.
 */
const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    provider: { type: String, required: true, trim: true, lowercase: true, maxlength: 40 },
    secret: { type: String, required: true, select: false },
    last4: { type: String, default: '' },
    baseUrl: { type: String, default: '', trim: true, maxlength: 300 },
    model: { type: String, default: '', trim: true, maxlength: 200 },
    status: { type: String, enum: ['active', 'invalid'], default: 'active' },
    lastVerifiedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

schema.index({ user: 1, provider: 1 }, { unique: true });

schema.methods.toPublic = function toPublic() {
  return {
    provider: this.provider,
    last4: this.last4,
    baseUrl: this.baseUrl || '',
    model: this.model || '',
    status: this.status,
    lastVerifiedAt: this.lastVerifiedAt,
    lastUsedAt: this.lastUsedAt,
    updatedAt: this.updatedAt,
  };
};

module.exports = mongoose.model('ProviderApiKey', schema);

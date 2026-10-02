const mongoose = require('mongoose');

/**
 * A buyer's linked Git host account for AI App Builder ("push to my GitHub").
 * `secret` holds the AES-GCM envelope from utils/secret-box and is never returned to clients.
 */
const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    provider: { type: String, enum: ['github'], required: true },
    /** oauth = GitHub OAuth app grant (revocable from our side); token = pasted personal access token. */
    method: { type: String, enum: ['oauth', 'token'], required: true },
    secret: { type: String, required: true, select: false },
    login: { type: String, default: '', maxlength: 100 },
    accountId: { type: String, default: '' },
    avatarUrl: { type: String, default: '', maxlength: 500 },
    scopes: { type: String, default: '', maxlength: 300 },
    status: { type: String, enum: ['active', 'invalid'], default: 'active' },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

schema.index({ user: 1, provider: 1 }, { unique: true });

schema.methods.toPublic = function toPublic() {
  return {
    provider: this.provider,
    method: this.method,
    login: this.login,
    avatarUrl: this.avatarUrl || '',
    scopes: this.scopes || '',
    status: this.status,
    lastUsedAt: this.lastUsedAt,
    connectedAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

module.exports = mongoose.model('GitConnection', schema);

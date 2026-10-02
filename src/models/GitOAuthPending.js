const mongoose = require('mongoose');

/**
 * GitHub OAuth result waiting for the signed-in client to claim it.
 * The callback cannot see the buyer's bearer token, so the grant is only attached to an account
 * when that same account calls /complete — a link started by someone else cannot hijack it.
 */
const schema = new mongoose.Schema({
  connectId: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  provider: { type: String, enum: ['github'], required: true },
  secret: { type: String, required: true, select: false },
  login: { type: String, default: '' },
  accountId: { type: String, default: '' },
  avatarUrl: { type: String, default: '' },
  scopes: { type: String, default: '' },
  expiresAt: { type: Date, required: true },
});

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('GitOAuthPending', schema);

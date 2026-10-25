const mongoose = require('mongoose');

/**
 * Short-lived per-user mutex for wallet spend. `_id` is the user id; a row whose
 * `until` has passed is free and can be taken over (crash safety).
 */
const walletLockSchema = new mongoose.Schema(
  {
    _id: { type: String },
    token: { type: String, required: true },
    until: { type: Date, required: true },
  },
  { versionKey: false }
);
walletLockSchema.index({ until: 1 }, { expireAfterSeconds: 3600 });

module.exports = mongoose.models.WalletLock || mongoose.model('WalletLock', walletLockSchema);

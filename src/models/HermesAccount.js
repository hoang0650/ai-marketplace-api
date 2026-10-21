const mongoose = require('mongoose');

/**
 * Per-buyer Hermes dashboard credentials.
 * Each account maps to an isolated Hermes profile `market-{userId}`.
 * Shared HERMES_DASHBOARD_BASIC_AUTH_* stays for operators only.
 */
const hermesAccountSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    /** AES-GCM envelope (secret-box). Legacy rows may still hold the plaintext until the next login. */
    password: { type: String, required: true },
    /** Hermes profile name — must match auth session org_id / lock. */
    profile: { type: String, required: true, unique: true },
  },
  { timestamps: { createdAt: true, updatedAt: true } },
);

hermesAccountSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

hermesAccountSchema.set('toJSON', { virtuals: true });
hermesAccountSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('HermesAccount', hermesAccountSchema);

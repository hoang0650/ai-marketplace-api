const mongoose = require('mongoose');

/**
 * Runtime record for one buyer's Hermes or NanoClaw container.
 * The provider key and the runtime token are not stored. `runtimeTokenHash`
 * is a SHA-256 of the per-container platform token (high entropy, not a password).
 */
const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    agent: { type: String, required: true, enum: ['hermes', 'nanoclaw'] },
    containerName: { type: String, required: true },
    volumeName: { type: String, required: true },
    networkName: { type: String, required: true },
    state: { type: String, enum: ['running', 'stopped'], default: 'stopped' },
    lastActiveAt: { type: Date, default: null },
    keySource: { type: String, enum: ['buyer', 'platform'], default: 'platform' },
    provider: { type: String, default: '' },
    model: { type: String, default: '' },
    last4: { type: String, default: '' },
    runtimeTokenHash: { type: String, default: '', select: false },
  },
  { timestamps: true },
);

schema.index({ user: 1, agent: 1 }, { unique: true });
schema.index({ runtimeTokenHash: 1 }, { sparse: true });

module.exports = mongoose.model('TenantAgent', schema);

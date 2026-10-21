const mongoose = require('mongoose');

/** Short-lived, single-use pairing code ("Tiếp tục trên điện thoại"). Only the hash is stored. */
const schema = new mongoose.Schema(
  {
    codeHash: { type: String, required: true, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fromDevice: { type: String, default: '', maxlength: 64 },
    target: {
      kind: { type: String, enum: ['builder', 'agent'], required: true },
      id: { type: String, required: true, maxlength: 64 },
      title: { type: String, default: '', maxlength: 120 },
    },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    usedByDevice: { type: String, default: '' },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true }
);
// Mongo removes expired codes on its own a while after expiry.
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

module.exports = mongoose.model('HandoffCode', schema);

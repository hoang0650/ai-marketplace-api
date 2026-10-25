const mongoose = require('mongoose');

/**
 * Client idempotency keys for metered calls, scoped per buyer (+ surface) so one buyer's
 * key can never replay or block another buyer's request. Claimed before the upstream call.
 */
const idempotencyClaimSchema = new mongoose.Schema(
  {
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    scope: { type: String, required: true, maxlength: 40 },
    key: { type: String, required: true, maxlength: 160 },
    status: { type: String, enum: ['pending', 'done'], default: 'pending' },
    response: { type: mongoose.Schema.Types.Mixed, default: null },
    usageEvent: { type: mongoose.Schema.Types.ObjectId, ref: 'UsageEvent', default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
idempotencyClaimSchema.index({ buyer: 1, scope: 1, key: 1 }, { unique: true });
idempotencyClaimSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 3600 });

module.exports = mongoose.models.IdempotencyClaim || mongoose.model('IdempotencyClaim', idempotencyClaimSchema);

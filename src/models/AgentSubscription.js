const mongoose = require('mongoose');

const PURGE_STATUSES = ['', 'done', 'manual_required', 'failed'];

/**
 * Monthly rental of a platform-hosted agent workspace (OpenClaw, Hermes, …).
 * Launch / runtime usage is only allowed while `paidUntil` is in the future;
 * token usage on platform models is billed separately per call.
 * The subscription worker auto-renews, reminds, expires and purges these rows.
 */
const agentSubscriptionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Canonical runtime id: openclaw | hermes | spacebot | nanoclaw | openwebui | paperclip. */
    agentId: { type: String, required: true, trim: true },
    startedAt: { type: Date, default: Date.now },
    paidUntil: { type: Date, required: true, index: true },
    autoRenew: { type: Boolean, default: true },
    lastChargedAt: { type: Date, default: null },
    /** Set when the latest charge was refunded (failed launch / support). Blocks auto-renew until the buyer pays again. */
    lastRefundedAt: { type: Date, default: null },
    lastFeeVnd: { type: Number, default: 0 },
    lastAmount: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' },
    periods: { type: Number, default: 0 },
    /** Worker bookkeeping — each holds the `paidUntil` it was sent for, so every period notifies once. */
    reminderFor: { type: Date, default: null },
    renewFailedFor: { type: Date, default: null },
    expiredFor: { type: Date, default: null },
    lastRenewAttemptAt: { type: Date, default: null },
    /** Workspace data is deleted at `purgeDueAt` when the plan was not renewed. */
    purgeDueAt: { type: Date, default: null, index: true },
    purgedAt: { type: Date, default: null },
    purgeStatus: { type: String, enum: PURGE_STATUSES, default: '' },
    purgeAttemptedAt: { type: Date, default: null },
    purgeError: { type: String, default: '' },
    /** Admin who confirmed a manual purge (null when the runtime webhook did it). */
    purgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    purgeNote: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: true } },
);

agentSubscriptionSchema.index({ user: 1, agentId: 1 }, { unique: true });

module.exports = mongoose.model('AgentSubscription', agentSubscriptionSchema);
module.exports.PURGE_STATUSES = PURGE_STATUSES;

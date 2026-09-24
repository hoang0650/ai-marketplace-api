const mongoose = require('mongoose');

const HIRED_STATUSES = ['running', 'archived', 'provisioning', 'stopped'];

/**
 * Server-side "My Agents" record so web and app show the same hired list
 * (the web used to keep this only in localStorage, which never synced devices).
 */
const hiredAgentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Marketplace agent id, e.g. `openclaw`, `hermes`, `nano-claw`. */
    agentId: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: HIRED_STATUSES, default: 'running', index: true },
    version: { type: String, default: '' },
    model: { type: String, default: '' },
    launchedAt: { type: Date, default: Date.now },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: true } },
);

// One row per (user, agent) — hiring the same agent twice updates the record.
hiredAgentSchema.index({ user: 1, agentId: 1 }, { unique: true });

hiredAgentSchema.virtual('id').get(function idVirtual() {
  return this._id.toString();
});

hiredAgentSchema.set('toJSON', { virtuals: true });
hiredAgentSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('HiredAgent', hiredAgentSchema);
module.exports.HIRED_STATUSES = HIRED_STATUSES;

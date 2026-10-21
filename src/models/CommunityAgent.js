const mongoose = require('mongoose');

/**
 * A community-submitted agent (public GitHub repo) in the Agent Marketplace "Vote" tab.
 * status: voting → pending_listing (cycle winner) → listed | rejected.
 * `active` is true for voting/pending_listing/listed: one active submission per repo.
 */
const communityAgentSchema = new mongoose.Schema(
  {
    repoKey: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    fullName: { type: String, required: true, trim: true, maxlength: 200 },
    githubId: { type: Number, default: null },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 500 },
    stars: { type: Number, default: 0 },
    avatarUrl: { type: String, default: '' },
    htmlUrl: { type: String, default: '' },
    language: { type: String, default: '' },
    license: { type: String, default: '' },
    fork: { type: Boolean, default: false },
    pushedAt: { type: Date, default: null },
    submitter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    submitterName: { type: String, default: '' },
    status: { type: String, enum: ['voting', 'pending_listing', 'listed', 'rejected'], default: 'voting', index: true },
    active: { type: Boolean, default: true },
    voteCount: { type: Number, default: 0, min: 0 },
    submittedAt: { type: Date, default: Date.now, index: true },
    candidateAt: { type: Date, default: null },
    candidateCycle: { type: String, default: '' },
    listedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: '', maxlength: 1000 },
  },
  { timestamps: true, collection: 'community_agents' }
);

communityAgentSchema.index({ repoKey: 1 }, { unique: true, partialFilterExpression: { active: true } });
communityAgentSchema.index({ status: 1, voteCount: -1, submittedAt: 1 });

module.exports = mongoose.model('CommunityAgent', communityAgentSchema);

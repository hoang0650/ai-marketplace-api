const mongoose = require('mongoose');

/** One vote per user per community agent (unique index). */
const communityAgentVoteSchema = new mongoose.Schema(
  {
    agent: { type: mongoose.Schema.Types.ObjectId, ref: 'CommunityAgent', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'community_agent_votes' }
);
communityAgentVoteSchema.index({ agent: 1, user: 1 }, { unique: true });

module.exports = mongoose.model('CommunityAgentVote', communityAgentVoteSchema);

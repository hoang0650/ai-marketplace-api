const mongoose = require('mongoose');

/** A closed vote cycle (idempotency for the cycle worker + history). */
const communityVoteCycleSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    period: { type: String, enum: ['monthly', 'weekly'], default: 'monthly' },
    closedAt: { type: Date, default: Date.now },
    manual: { type: Boolean, default: false },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    winner: { type: mongoose.Schema.Types.ObjectId, ref: 'CommunityAgent', default: null },
    winnerVotes: { type: Number, default: 0 },
  },
  { collection: 'community_vote_cycles' }
);

module.exports = mongoose.model('CommunityVoteCycle', communityVoteCycleSchema);

const CommunityAgent = require('../models/CommunityAgent');
const CommunityAgentVote = require('../models/CommunityAgentVote');
const CommunityVoteCycle = require('../models/CommunityVoteCycle');

const plain = (d) => (d ? { ...d, _id: String(d._id), submitter: String(d.submitter) } : null);

function createMongoRepo() {
  return {
    async findActiveByKey(repoKey) {
      return plain(await CommunityAgent.findOne({ repoKey, active: true }).lean());
    },
    async countSubmissionsSince(userId, since) {
      return CommunityAgent.countDocuments({ submitter: userId, submittedAt: { $gte: since } });
    },
    async createAgent(doc) {
      const created = await CommunityAgent.create(doc);
      return plain(created.toObject());
    },
    async getAgent(id) {
      if (!/^[a-f0-9]{24}$/i.test(String(id))) return null;
      return plain(await CommunityAgent.findById(id).lean());
    },
    async updateAgent(id, expectStatus, patch) {
      return plain(await CommunityAgent.findOneAndUpdate({ _id: id, status: expectStatus }, { $set: patch }, { new: true }).lean());
    },
    async listAgents(statuses) {
      return (await CommunityAgent.find({ status: { $in: statuses } }).limit(1000).lean()).map(plain);
    },
    async addVote(agentId, userId) {
      try {
        await CommunityAgentVote.create({ agent: agentId, user: userId });
        return true;
      } catch (e) {
        if (e?.code === 11000) return false;
        throw e;
      }
    },
    async removeVote(agentId, userId) {
      const r = await CommunityAgentVote.deleteOne({ agent: agentId, user: userId });
      return r.deletedCount > 0;
    },
    async incVotes(agentId, delta) {
      await CommunityAgent.updateOne({ _id: agentId }, { $inc: { voteCount: delta } });
      if (delta < 0) await CommunityAgent.updateOne({ _id: agentId, voteCount: { $lt: 0 } }, { $set: { voteCount: 0 } });
    },
    async votedAgentIds(userId, agentIds) {
      if (!agentIds.length) return [];
      const rows = await CommunityAgentVote.find({ user: userId, agent: { $in: agentIds } }).select('agent').lean();
      return rows.map((r) => String(r.agent));
    },
    async getCycle(key) {
      return CommunityVoteCycle.findOne({ key }).lean();
    },
    async saveCycle(doc) {
      try {
        return (await CommunityVoteCycle.create(doc)).toObject();
      } catch (e) {
        if (e?.code === 11000) return CommunityVoteCycle.findOne({ key: doc.key }).lean();
        throw e;
      }
    },
    async lastCycle() {
      return CommunityVoteCycle.findOne({}).sort({ closedAt: -1 }).lean();
    },
  };
}

module.exports = { createMongoRepo };

/** In-memory repo for the vote service (tests / fake API). Mirrors mongo-repo semantics. */
function createMemoryRepo() {
  const agents = new Map();
  const votes = new Set();
  const cycles = new Map();
  let seq = 0;
  const copy = (a) => (a ? { ...a } : null);
  return {
    agents,
    votes,
    async findActiveByKey(key) {
      return copy([...agents.values()].find((a) => a.repoKey === key && a.active));
    },
    async countSubmissionsSince(userId, since) {
      return [...agents.values()].filter((a) => String(a.submitter) === String(userId) && a.submittedAt >= since).length;
    },
    async createAgent(doc) {
      if ([...agents.values()].some((a) => a.repoKey === doc.repoKey && a.active)) throw Object.assign(new Error('dup'), { code: 11000 });
      const _id = `ca${(++seq).toString().padStart(4, '0')}`;
      agents.set(_id, { _id, ...doc });
      return copy(agents.get(_id));
    },
    async getAgent(id) {
      return copy(agents.get(String(id)));
    },
    async updateAgent(id, expectStatus, patch) {
      const a = agents.get(String(id));
      if (!a || a.status !== expectStatus) return null;
      Object.assign(a, patch);
      return copy(a);
    },
    async listAgents(statuses) {
      return [...agents.values()].filter((a) => statuses.includes(a.status)).map(copy);
    },
    async addVote(agentId, userId) {
      const k = `${agentId}:${userId}`;
      if (votes.has(k)) return false;
      votes.add(k);
      return true;
    },
    async removeVote(agentId, userId) {
      return votes.delete(`${agentId}:${userId}`);
    },
    async incVotes(agentId, delta) {
      const a = agents.get(String(agentId));
      if (a) a.voteCount = Math.max(0, (a.voteCount || 0) + delta);
    },
    async votedAgentIds(userId, agentIds) {
      return agentIds.filter((id) => votes.has(`${id}:${userId}`));
    },
    async getCycle(key) {
      return copy(cycles.get(key));
    },
    async saveCycle(doc) {
      cycles.set(doc.key, doc);
      return copy(doc);
    },
    async lastCycle() {
      return copy([...cycles.values()].sort((a, b) => b.closedAt - a.closedAt)[0]);
    },
  };
}

module.exports = { createMemoryRepo };

/**
 * Community agent voting: submit a public GitHub repo, vote, monthly/weekly cycle close picks the
 * top 1 as 'pending_listing', admin approves (→ 'listed') or rejects (→ next in line).
 * Storage goes through `repo` (Mongo in prod, in-memory in tests).
 */
const { parseRepoUrl, fetchPublicRepo, RepoError } = require('./github-repo');
const { cyclePeriod, cycleInfo, previousCycle } = require('./vote-cycle');

const STATUSES = ['voting', 'pending_listing', 'listed', 'rejected'];
const ACTIVE = new Set(['voting', 'pending_listing', 'listed']);

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

function voteConfig(env = process.env) {
  return {
    period: cyclePeriod(env),
    minAccountAgeHours: num(env.VOTE_MIN_ACCOUNT_AGE_HOURS, 24),
    maxSubmissionsPerDay: num(env.VOTE_MAX_SUBMISSIONS_PER_DAY, 3),
  };
}

const err = (code, message, status = 400) => new RepoError(code, message, status);
const uid = (u) => String(u?._id || u?.id || u || '');

function createVoteService({ repo, fetchRepo = fetchPublicRepo, now = () => new Date(), config = voteConfig() } = {}) {
  /** Basic anti-abuse: account age; Google sign-in counts as a verified email; banned users never get here. */
  function assertEligible(user, action) {
    if (!user) throw err('unauthorized', 'Login required.', 401);
    if (user.role === 'admin') return;
    const created = user.createdAt ? new Date(user.createdAt).getTime() : 0;
    const ageH = created ? (now().getTime() - created) / 3600e3 : Infinity;
    if (ageH < config.minAccountAgeHours) {
      throw err('account_too_new', `Accounts must be at least ${config.minAccountAgeHours}h old to ${action}.`, 403);
    }
    if (user.emailVerified === false) throw err('email_unverified', 'Verify your email first.', 403);
  }

  async function submit(user, url) {
    assertEligible(user, 'submit');
    const parsed = parseRepoUrl(url);
    if (!parsed) throw err('invalid_url', 'Enter a GitHub repository URL like https://github.com/owner/repo.');
    const since = new Date(now().getTime() - 24 * 3600e3);
    if ((await repo.countSubmissionsSince(uid(user), since)) >= config.maxSubmissionsPerDay) {
      throw err('rate_limited', 'Too many submissions today. Try again tomorrow.', 429);
    }
    const quickKey = `${parsed.owner}/${parsed.repo}`.toLowerCase();
    const pre = await repo.findActiveByKey(quickKey);
    if (pre) throw Object.assign(err('duplicate', 'This repository has already been submitted.', 409), { agent: pre });
    const meta = await fetchRepo(parsed);
    const dup = meta.repoKey !== quickKey ? await repo.findActiveByKey(meta.repoKey) : null;
    if (dup) throw Object.assign(err('duplicate', 'This repository has already been submitted.', 409), { agent: dup });
    try {
      return await repo.createAgent({
        ...meta,
        submitter: uid(user),
        submitterName: user.name || '',
        status: 'voting',
        active: true,
        voteCount: 0,
        submittedAt: now(),
      });
    } catch (e) {
      if (e?.code === 11000) throw err('duplicate', 'This repository has already been submitted.', 409);
      throw e;
    }
  }

  async function loadVoting(agentId) {
    const agent = await repo.getAgent(agentId);
    if (!agent) throw err('not_found', 'Agent not found.', 404);
    if (agent.status !== 'voting') throw err('voting_closed', 'Voting is closed for this agent.', 409);
    return agent;
  }

  async function vote(user, agentId) {
    assertEligible(user, 'vote');
    const agent = await loadVoting(agentId);
    if (String(agent.submitter) === uid(user)) throw err('own_agent', 'You cannot vote for your own submission.', 403);
    const added = await repo.addVote(String(agent._id), uid(user), now());
    if (added) await repo.incVotes(String(agent._id), 1);
    return { voted: true, changed: added, voteCount: (await repo.getAgent(agentId)).voteCount };
  }

  async function unvote(user, agentId) {
    if (!user) throw err('unauthorized', 'Login required.', 401);
    const agent = await loadVoting(agentId);
    const removed = await repo.removeVote(String(agent._id), uid(user));
    if (removed) await repo.incVotes(String(agent._id), -1);
    return { voted: false, changed: removed, voteCount: (await repo.getAgent(agentId)).voteCount };
  }

  const rank = (a, b) => b.voteCount - a.voteCount || new Date(a.submittedAt) - new Date(b.submittedAt);

  async function board(user) {
    const all = await repo.listAgents(['voting', 'pending_listing', 'listed']);
    const leaderboard = all.filter((a) => a.status === 'voting').sort(rank);
    const mine = user ? new Set(await repo.votedAgentIds(uid(user), leaderboard.map((a) => String(a._id)))) : new Set();
    const lastClosed = await repo.lastCycle();
    return {
      cycle: { ...cycleInfo(now(), config.period), lastClosed: lastClosed || null },
      leaderboard: leaderboard.map((a, i) => ({ ...a, rank: i + 1, votedByMe: mine.has(String(a._id)), mine: !!user && String(a.submitter) === uid(user) })),
      pending: all.filter((a) => a.status === 'pending_listing').sort((a, b) => new Date(a.candidateAt) - new Date(b.candidateAt)),
      listed: all.filter((a) => a.status === 'listed').sort((a, b) => new Date(b.listedAt) - new Date(a.listedAt)),
    };
  }

  /** Promote the current top voting agent (votes > 0) to 'pending_listing'. */
  async function promoteTop(cycleKey) {
    const top = (await repo.listAgents(['voting'])).filter((a) => a.voteCount > 0).sort(rank)[0];
    if (!top) return null;
    return repo.updateAgent(String(top._id), 'voting', { status: 'pending_listing', candidateAt: now(), candidateCycle: cycleKey });
  }

  /**
   * Close a cycle. `manual` closes the current cycle now; otherwise the previous cycle is closed once
   * (idempotent via the cycle record).
   */
  async function closeCycle({ manual = false, by = null } = {}) {
    const info = manual ? cycleInfo(now(), config.period) : previousCycle(now(), config.period);
    const existing = await repo.getCycle(info.key);
    if (existing) return { closed: false, alreadyClosed: true, cycle: existing };
    const winner = await promoteTop(info.key);
    const cycle = await repo.saveCycle({
      key: info.key,
      period: info.period,
      closedAt: now(),
      manual,
      closedBy: by ? uid(by) : null,
      winner: winner ? String(winner._id) : null,
      winnerVotes: winner ? winner.voteCount : 0,
    });
    return { closed: true, cycle, winner };
  }

  async function review(admin, agentId, decision, note = '') {
    if (!admin || admin.role !== 'admin') throw err('forbidden', 'Admin only.', 403);
    const agent = await repo.getAgent(agentId);
    if (!agent) throw err('not_found', 'Agent not found.', 404);
    if (agent.status !== 'pending_listing') throw err('not_pending', 'Only pending candidates can be reviewed.', 409);
    const base = { reviewedBy: uid(admin), reviewedAt: now(), reviewNote: String(note || '').slice(0, 1000) };
    if (decision === 'approve') {
      const listed = await repo.updateAgent(agentId, 'pending_listing', { ...base, status: 'listed', listedAt: now() });
      return { agent: listed, next: null };
    }
    const rejected = await repo.updateAgent(agentId, 'pending_listing', { ...base, status: 'rejected', active: false, rejectedAt: now() });
    const next = await promoteTop(agent.candidateCycle || cycleInfo(now(), config.period).key);
    return { agent: rejected, next };
  }

  return { submit, vote, unvote, board, closeCycle, review, assertEligible, config };
}

module.exports = { createVoteService, voteConfig, STATUSES, ACTIVE };

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createVoteService } = require('../../src/community/agent-vote-service');
const { createMemoryRepo } = require('../../src/community/memory-repo');
const { parseRepoUrl, fetchPublicRepo, _setFetch } = require('../../src/community/github-repo');
const { cycleInfo, previousCycle } = require('../../src/community/vote-cycle');
const createRouter = require('../../src/routes/community-agents');

const OLD = new Date('2026-01-01T00:00:00Z');
const user = (id, extra = {}) => ({ _id: id, name: id, role: 'buyer', createdAt: OLD, ...extra });
const meta = (full, extra = {}) => ({ fullName: full, repoKey: full.toLowerCase(), name: full.split('/')[1], description: 'd', stars: 5, avatarUrl: 'a', htmlUrl: `https://github.com/${full}`, ...extra });

function setup(nowIso = '2026-10-15T03:00:00Z') {
  const repo = createMemoryRepo();
  let now = new Date(nowIso);
  const svc = createVoteService({
    repo,
    now: () => now,
    fetchRepo: async ({ owner, repo: r }) => meta(`${owner}/${r}`),
    config: { period: 'monthly', minAccountAgeHours: 24, maxSubmissionsPerDay: 3 },
  });
  return { repo, svc, setNow: (iso) => (now = new Date(iso)) };
}

test('parseRepoUrl accepts GitHub repo URLs only', () => {
  assert.deepEqual(parseRepoUrl('https://github.com/Owner/my-agent.git'), { owner: 'Owner', repo: 'my-agent' });
  assert.deepEqual(parseRepoUrl('github.com/o/r/tree/main'), { owner: 'o', repo: 'r' });
  assert.equal(parseRepoUrl('https://gitlab.com/o/r'), null);
  assert.equal(parseRepoUrl('https://github.com/o'), null);
});

test('fetchPublicRepo rejects missing, private and archived repos', async (t) => {
  t.after(() => _setFetch(null));
  const reply = (status, body) => _setFetch(async () => ({ status, ok: status < 300, json: async () => body }));
  reply(404, {});
  await assert.rejects(fetchPublicRepo({ owner: 'o', repo: 'r' }), { code: 'repo_not_found' });
  reply(200, { full_name: 'o/r', private: true });
  await assert.rejects(fetchPublicRepo({ owner: 'o', repo: 'r' }), { code: 'repo_not_public' });
  reply(200, { full_name: 'o/r', archived: true, visibility: 'public' });
  await assert.rejects(fetchPublicRepo({ owner: 'o', repo: 'r' }), { code: 'repo_archived' });
  reply(200, { full_name: 'O/R', name: 'R', visibility: 'public', stargazers_count: 42, owner: { avatar_url: 'x' }, html_url: 'h' });
  const m = await fetchPublicRepo({ owner: 'o', repo: 'r' });
  assert.equal(m.repoKey, 'o/r');
  assert.equal(m.stars, 42);
});

test('one active submission per repo (dedupe, case-insensitive)', async () => {
  const { svc } = setup();
  const a = await svc.submit(user('u1'), 'https://github.com/acme/agent');
  assert.equal(a.status, 'voting');
  await assert.rejects(svc.submit(user('u2'), 'https://github.com/ACME/agent'), { code: 'duplicate' });
});

test('new accounts cannot vote or submit; submission rate limited', async () => {
  const { svc } = setup();
  await assert.rejects(svc.submit(user('n', { createdAt: new Date('2026-10-15T00:00:00Z') }), 'github.com/a/b'), { code: 'account_too_new' });
  for (const r of ['x1', 'x2', 'x3']) await svc.submit(user('u1'), `github.com/o/${r}`);
  await assert.rejects(svc.submit(user('u1'), 'github.com/o/x4'), { code: 'rate_limited' });
});

test('vote uniqueness: one vote per user per agent, unvote allowed', async () => {
  const { svc } = setup();
  const a = await svc.submit(user('u1'), 'github.com/o/r');
  assert.equal((await svc.vote(user('u2'), a._id)).voteCount, 1);
  const again = await svc.vote(user('u2'), a._id);
  assert.equal(again.changed, false);
  assert.equal(again.voteCount, 1);
  assert.equal((await svc.vote(user('u3'), a._id)).voteCount, 2);
  assert.equal((await svc.unvote(user('u2'), a._id)).voteCount, 1);
  assert.equal((await svc.unvote(user('u2'), a._id)).voteCount, 1);
});

test('submitter cannot vote for own agent', async () => {
  const { svc } = setup();
  const a = await svc.submit(user('u1'), 'github.com/o/r');
  await assert.rejects(svc.vote(user('u1'), a._id), { code: 'own_agent' });
});

test('cycle close picks top 1 (tie → earliest submission); listed agents leave the leaderboard and voting closes', async () => {
  const { svc, setNow } = setup('2026-10-02T00:00:00Z');
  const first = await svc.submit(user('u1'), 'github.com/o/first');
  setNow('2026-10-03T00:00:00Z');
  const second = await svc.submit(user('u2'), 'github.com/o/second');
  const third = await svc.submit(user('u3'), 'github.com/o/third');
  for (const v of ['v1', 'v2']) {
    await svc.vote(user(v), first._id);
    await svc.vote(user(v), second._id);
  }
  await svc.vote(user('v1'), third._id);

  setNow('2026-11-01T01:00:00Z'); // next month (Asia/Bangkok) → October cycle closes
  const r = await svc.closeCycle();
  assert.equal(r.closed, true);
  assert.equal(r.cycle.key, '2026-10');
  assert.equal(r.winner._id, first._id, 'tie-break: earliest submission');
  assert.equal(r.winner.status, 'pending_listing');
  assert.equal((await svc.closeCycle()).alreadyClosed, true, 'idempotent');

  let b = await svc.board(user('v3'));
  assert.deepEqual(b.leaderboard.map((a) => a._id), [second._id, third._id]);
  assert.equal(b.pending[0]._id, first._id);
  await assert.rejects(svc.vote(user('v3'), first._id), { code: 'voting_closed' });

  await svc.review(user('admin', { role: 'admin' }), first._id, 'approve');
  b = await svc.board(null);
  assert.deepEqual(b.listed.map((a) => a._id), [first._id]);
  assert.ok(!b.leaderboard.some((a) => a._id === first._id));
  await assert.rejects(svc.vote(user('v3'), first._id), { code: 'voting_closed' });
  // A listed repo stays active: cannot be resubmitted.
  await assert.rejects(svc.submit(user('v3'), 'github.com/o/first'), { code: 'duplicate' });
});

test('reject moves candidate to rejected and promotes the next in line', async () => {
  const { svc } = setup();
  const a = await svc.submit(user('u1'), 'github.com/o/a');
  const b = await svc.submit(user('u2'), 'github.com/o/b');
  await svc.vote(user('v1'), a._id);
  await svc.vote(user('v2'), a._id);
  await svc.vote(user('v1'), b._id);
  await svc.closeCycle({ manual: true, by: user('admin', { role: 'admin' }) });
  const r = await svc.review(user('admin', { role: 'admin' }), a._id, 'reject', 'unsafe postinstall');
  assert.equal(r.agent.status, 'rejected');
  assert.equal(r.next._id, b._id);
  assert.equal(r.next.status, 'pending_listing');
  await assert.rejects(svc.review(user('u9'), b._id, 'approve'), { code: 'forbidden' });
});

test('cycle keys: monthly (Bangkok) and weekly ISO', () => {
  assert.equal(cycleInfo(new Date('2026-10-31T17:30:00Z'), 'monthly').key, '2026-11'); // 00:30 1/11 ICT
  assert.equal(previousCycle(new Date('2026-11-01T01:00:00Z'), 'monthly').key, '2026-10');
  assert.equal(cycleInfo(new Date('2026-10-15T03:00:00Z'), 'weekly').key, '2026-W42');
});

test('HTTP: approve / reject / close-cycle are admin-only', async (t) => {
  const { svc } = setup();
  const fakeAuth = (req, res, next) => {
    const role = req.headers['x-role'];
    if (!role) return res.status(401).json({ code: 'UNAUTHORIZED' });
    req.user = user(`u-${role}`, { role });
    next();
  };
  const { requireRoles } = require('../../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use('/v1/community-agents', createRouter({ service: svc, authenticate: fakeAuth, optionalAuth: (_q, _s, n) => n(), requireAdmin: requireRoles('admin') }));
  const srv = app.listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}/v1/community-agents`;
  const call = (method, path, role, body) =>
    fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(role ? { 'x-role': role } : {}) }, body: body ? JSON.stringify(body) : undefined });

  const created = await (await call('POST', '/', 'buyer', { repoUrl: 'https://github.com/o/http' })).json();
  const id = created.agent._id;
  assert.equal((await call('POST', `/${id}/vote`, 'seller')).status, 200);
  assert.equal((await call('POST', '/admin/close-cycle', 'buyer')).status, 403);
  assert.equal((await call('POST', '/admin/close-cycle', null)).status, 401);
  assert.equal((await call('POST', '/admin/close-cycle', 'admin')).status, 200);
  assert.equal((await call('POST', `/admin/${id}/approve`, 'seller')).status, 403);
  assert.equal((await call('GET', '/admin/pending', 'buyer')).status, 403);
  const ok = await call('POST', `/admin/${id}/approve`, 'admin', { note: 'reviewed' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).agent.status, 'listed');
  const listed = await (await call('GET', '/listed')).json();
  assert.equal(listed.items.length, 1);
  assert.equal((await call('POST', `/${id}/vote`, 'talent')).status, 409);
});

/**
 * Agent Marketplace "Vote" tab.
 *   GET    /v1/community-agents                 leaderboard + pending + listed (+ my votes when logged in)
 *   GET    /v1/community-agents/listed          listed community agents (Public tab)
 *   POST   /v1/community-agents                 { repoUrl } submit a public GitHub repo (login)
 *   POST   /v1/community-agents/:id/vote        vote (login; not own; voting only)
 *   DELETE /v1/community-agents/:id/vote        unvote
 *   GET    /v1/community-agents/admin/pending   admin: candidates
 *   POST   /v1/community-agents/admin/:id/approve | /reject   { note }
 *   POST   /v1/community-agents/admin/close-cycle            close current cycle now
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const { createVoteService } = require('../community/agent-vote-service');

function publicAgent(a) {
  if (!a) return a;
  const { active, __v, reviewedBy, ...rest } = a;
  return rest;
}

function createRouter({
  service,
  authenticate = auth.authenticate,
  optionalAuth = auth.optionalAuth,
  requireAdmin = auth.requireRoles('admin'),
  limiterMax = 30,
} = {}) {
  const svc = service || createVoteService({ repo: require('../community/mongo-repo').createMongoRepo() });
  const router = express.Router();
  // Limiters run after authenticate, so the key is always the user id.
  const userKey = (req) => `cv:${String(req.user?._id || req.user?.id || 'anon')}`;
  const voteLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: limiterMax, standardHeaders: false, legacyHeaders: false, keyGenerator: userKey, message: { code: 'rate_limited', message: 'Too many requests. Slow down.' } });
  const submitLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: false, legacyHeaders: false, keyGenerator: userKey, message: { code: 'rate_limited', message: 'Too many submissions. Try again later.' } });

  const send = (res, e, next) => {
    if (e && e.status && e.code) {
      return res.status(e.status).json({ code: e.code, message: e.message, ...(e.agent ? { agent: publicAgent(e.agent) } : {}) });
    }
    return next(e);
  };

  router.get('/', optionalAuth, async (req, res, next) => {
    try {
      const b = await svc.board(req.user || null);
      res.json({
        cycle: b.cycle,
        leaderboard: b.leaderboard.map(publicAgent),
        pending: b.pending.map(publicAgent),
        listed: b.listed.map(publicAgent),
        loggedIn: !!req.user,
      });
    } catch (e) {
      send(res, e, next);
    }
  });

  router.get('/listed', async (_req, res, next) => {
    try {
      const b = await svc.board(null);
      res.json({ items: b.listed.map(publicAgent) });
    } catch (e) {
      send(res, e, next);
    }
  });

  router.post('/', authenticate, submitLimiter, async (req, res, next) => {
    try {
      const agent = await svc.submit(req.user, req.body?.repoUrl || req.body?.url);
      res.status(201).json({ agent: publicAgent(agent) });
    } catch (e) {
      send(res, e, next);
    }
  });

  router.post('/:id/vote', authenticate, voteLimiter, async (req, res, next) => {
    try {
      res.json(await svc.vote(req.user, req.params.id));
    } catch (e) {
      send(res, e, next);
    }
  });

  router.delete('/:id/vote', authenticate, voteLimiter, async (req, res, next) => {
    try {
      res.json(await svc.unvote(req.user, req.params.id));
    } catch (e) {
      send(res, e, next);
    }
  });

  const admin = express.Router();
  admin.use(authenticate, requireAdmin);
  admin.get('/pending', async (_req, res, next) => {
    try {
      const b = await svc.board(null);
      res.json({ pending: b.pending.map(publicAgent), leaderboard: b.leaderboard.slice(0, 10).map(publicAgent), listed: b.listed.map(publicAgent), cycle: b.cycle });
    } catch (e) {
      send(res, e, next);
    }
  });
  admin.post('/:id/approve', async (req, res, next) => {
    try {
      const r = await svc.review(req.user, req.params.id, 'approve', req.body?.note);
      res.json({ agent: publicAgent(r.agent) });
    } catch (e) {
      send(res, e, next);
    }
  });
  admin.post('/:id/reject', async (req, res, next) => {
    try {
      const r = await svc.review(req.user, req.params.id, 'reject', req.body?.note);
      res.json({ agent: publicAgent(r.agent), next: publicAgent(r.next) });
    } catch (e) {
      send(res, e, next);
    }
  });
  admin.post('/close-cycle', async (req, res, next) => {
    try {
      const r = await svc.closeCycle({ manual: true, by: req.user });
      res.json({ closed: r.closed, alreadyClosed: !!r.alreadyClosed, cycle: r.cycle, winner: publicAgent(r.winner || null) });
    } catch (e) {
      send(res, e, next);
    }
  });
  router.use('/admin', admin);
  return router;
}

module.exports = createRouter;
module.exports.createRouter = createRouter;

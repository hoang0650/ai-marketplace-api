const express = require('express');
const TerminalSession = require('../models/TerminalSession');
const { authenticate, requireRoles } = require('../middleware/auth');
const provider = require('../utils/denglish-providers');
const {
  assertServerOwner,
  newSessionId,
  MAX_TERMINALS_PER_USER,
  audit,
} = require('../terminal/permission.service');

const router = express.Router();
router.use(authenticate, requireRoles('creator', 'admin', 'buyer'));

function publicSession(doc) {
  return {
    sessionId: doc.sessionId,
    projectId: doc.projectId,
    serverId: String(doc.server),
    provider: doc.provider,
    status: doc.status,
    createdAt: doc.createdAt,
    lastActivityAt: doc.lastActivityAt,
  };
}

router.post('/sessions', async (req, res, next) => {
  try {
    const projectId = String(req.body?.projectId || 'default');
    const serverId = String(req.body?.serverId || '');
    if (!serverId) return res.status(400).json({ message: 'serverId required', code: 'SERVER_NOT_FOUND' });

    const server = await assertServerOwner(req.user, serverId);
    const open = await TerminalSession.countDocuments({
      user: req.user._id,
      status: { $in: ['starting', 'connected'] },
    });
    if (open >= MAX_TERMINALS_PER_USER) {
      return res.status(429).json({ message: 'Too many terminal sessions', code: 'FORBIDDEN' });
    }

    await provider.createProviderTerminal(server.provider, server.providerServerId);
    const sessionId = newSessionId('ts');
    const doc = await TerminalSession.create({
      sessionId,
      user: req.user._id,
      projectId,
      server: server._id,
      provider: server.provider,
      providerServerId: server.providerServerId,
      status: 'starting',
    });
    await audit({
      sessionId,
      user: req.user._id,
      projectId,
      serverId: String(server._id),
      event: 'session_create',
    });
    res.status(201).json(publicSession(doc));
  } catch (e) {
    next(e);
  }
});

router.get('/sessions/:sessionId', async (req, res, next) => {
  try {
    const doc = await TerminalSession.findOne({ sessionId: req.params.sessionId, user: req.user._id });
    if (!doc) return res.status(404).json({ message: 'SESSION_EXPIRED', code: 'SESSION_EXPIRED' });
    res.json(publicSession(doc));
  } catch (e) {
    next(e);
  }
});

router.delete('/sessions/:sessionId', async (req, res, next) => {
  try {
    const doc = await TerminalSession.findOne({ sessionId: req.params.sessionId, user: req.user._id });
    if (!doc) return res.status(404).json({ message: 'SESSION_EXPIRED', code: 'SESSION_EXPIRED' });
    doc.status = 'disconnected';
    doc.disconnectedAt = new Date();
    doc.disconnectReason = 'user';
    await doc.save();
    try {
      await provider.closeProviderTerminal(doc.provider, doc.sessionId);
    } catch (_) {
      /* ignore */
    }
    await audit({
      sessionId: doc.sessionId,
      user: req.user._id,
      projectId: doc.projectId,
      serverId: String(doc.server),
      event: 'session_close',
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;

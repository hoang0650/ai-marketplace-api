const express = require('express');
const mongoose = require('mongoose');
const TenantAgent = require('../models/TenantAgent');
const { authenticate, requireRoles } = require('../middleware/auth');
const { writeAuditLog } = require('../utils/audit');
const { moderationView, TENANT_AGENTS } = require('../services/tenant-runtime');

const router = express.Router();
router.use(authenticate, requireRoles('admin'));

const USER_ID_RE = /^[a-f0-9]{24}$/i;

/**
 * Audited look at one buyer's container. The response has names and key
 * source only — not the provider key, the runtime token, or file contents.
 */
router.post('/:agentId/:userId', async (req, res, next) => {
  try {
    const agentId = String(req.params.agentId || '').toLowerCase();
    const userId = String(req.params.userId || '').toLowerCase();
    if (!TENANT_AGENTS.includes(agentId) || !USER_ID_RE.test(userId)) {
      return res.status(400).json({ message: 'Unknown tenant.' });
    }
    const record = await TenantAgent.findOne({ user: new mongoose.Types.ObjectId(userId), agent: agentId }).lean();
    if (!record) return res.status(404).json({ message: 'No runtime record for this buyer.' });
    let view;
    try {
      view = moderationView(
        {
          agentId,
          userId,
          containerName: record.containerName,
          volumeName: record.volumeName,
          networkName: record.networkName,
          state: record.state,
          keySource: record.keySource,
          last4: record.last4,
          lastActiveAt: record.lastActiveAt,
        },
        { reason: req.body?.reason },
      );
    } catch (err) {
      return res.status(err.status || 400).json({ message: err.message });
    }
    await writeAuditLog({
      actorId: req.user._id,
      actorRole: req.user.role,
      action: 'tenant.moderation_access',
      resourceType: 'TenantAgent',
      resourceId: String(record._id),
      newValue: view,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      reason: view.reason,
    });
    return res.json({ success: true, tenant: view });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

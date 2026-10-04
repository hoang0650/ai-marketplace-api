const express = require('express');
const AgentSubscription = require('../models/AgentSubscription');
const User = require('../models/User');
const { authenticate, requireRoles } = require('../middleware/auth');
const { AGENT_IDS, AGENT_LABELS } = require('../finance/agent-subscription');
const {
  ENV_PREFIX,
  executePurge,
  markPurged,
  purgeWebhookConfigured,
} = require('../finance/agent-subscription-worker');

const router = express.Router();
router.use(authenticate, requireRoles('admin'));

const TABS = ['manual', 'failed', 'upcoming', 'done'];

function tabFilter(tab) {
  if (tab === 'manual') return { purgeStatus: 'manual_required', purgedAt: null };
  if (tab === 'failed') return { purgeStatus: 'failed', purgedAt: null };
  if (tab === 'upcoming') return { purgeStatus: '', purgedAt: null, purgeDueAt: { $ne: null } };
  return { purgeStatus: 'done' };
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Buyer's runtime URL (same template the launch routes use). */
function workspaceUrl(agentId, userId) {
  const template =
    process.env[`${ENV_PREFIX[agentId]}_AIMARKETS_PUBLIC_URL_TEMPLATE`] || `https://{userId}.${agentId}.aimarkets.vn`;
  return String(template).replace(/\{userId\}|\{tenant\}/gi, userId).replace(/\/$/, '');
}

function mapRow(r) {
  const userId = r.user?._id ? String(r.user._id) : String(r.user || '');
  return {
    id: String(r._id),
    agentId: r.agentId,
    label: AGENT_LABELS[r.agentId] || r.agentId,
    user: r.user?._id ? { id: userId, email: r.user.email || '', name: r.user.name || '' } : { id: userId, email: '', name: '' },
    workspaceUrl: workspaceUrl(r.agentId, userId),
    /** Session / Hermes profile name on the runtime host. */
    workspace: `market-${userId}`,
    paidUntil: r.paidUntil,
    purgeDueAt: r.purgeDueAt,
    purgeStatus: r.purgeStatus || '',
    purgeAttemptedAt: r.purgeAttemptedAt || null,
    purgeError: r.purgeError || '',
    purgedAt: r.purgedAt || null,
    purgedBy: r.purgedBy?._id ? { id: String(r.purgedBy._id), email: r.purgedBy.email, name: r.purgedBy.name } : null,
    purgeNote: r.purgeNote || '',
    webhookConfigured: purgeWebhookConfigured(r.agentId),
  };
}

/** GET /v1/admin/agent-purges?tab=manual|failed|upcoming|done&q= — workspace data purge queue. */
router.get('/', async (req, res, next) => {
  try {
    const tab = TABS.includes(req.query.tab) ? req.query.tab : 'manual';
    const filter = tabFilter(tab);
    const q = String(req.query.q || '').trim();
    if (q) {
      const or = [{ email: new RegExp(escapeRegex(q), 'i') }, { name: new RegExp(escapeRegex(q), 'i') }];
      if (/^[a-f0-9]{24}$/i.test(q)) or.push({ _id: q });
      const users = await User.find({ $or: or }).select('_id').limit(200).lean();
      filter.user = { $in: users.map((u) => u._id) };
    }
    const sort = tab === 'done' ? { purgedAt: -1 } : { purgeDueAt: 1 };
    const [rows, ...counts] = await Promise.all([
      AgentSubscription.find(filter)
        .sort(sort)
        .limit(200)
        .populate('user', 'email name')
        .populate('purgedBy', 'email name')
        .lean(),
      ...TABS.map((t) => AgentSubscription.countDocuments(tabFilter(t))),
    ]);
    res.json({
      tab,
      items: rows.map(mapRow),
      counts: Object.fromEntries(TABS.map((t, i) => [t, counts[i]])),
      runtimes: AGENT_IDS.map((agentId) => ({
        agentId,
        label: AGENT_LABELS[agentId],
        webhookConfigured: purgeWebhookConfigured(agentId),
        webhookEnv: `${ENV_PREFIX[agentId]}_AIMARKETS_PURGE_URL`,
      })),
    });
  } catch (err) {
    next(err);
  }
});

async function loadExpired(id, res) {
  const doc = await AgentSubscription.findById(id).lean();
  if (!doc) {
    res.status(404).json({ message: 'Subscription not found' });
    return null;
  }
  if (doc.purgedAt) {
    res.status(409).json({ message: 'Already purged' });
    return null;
  }
  if (new Date(doc.paidUntil).getTime() > Date.now()) {
    res.status(409).json({ message: 'Plan was renewed — do not purge.' });
    return null;
  }
  return doc;
}

/** POST /v1/admin/agent-purges/:id/retry — call the runtime purge webhook again now. */
router.post('/:id/retry', async (req, res, next) => {
  try {
    const doc = await loadExpired(req.params.id, res);
    if (!doc) return undefined;
    const user = await User.findById(doc.user).select('email name role').lean();
    const status = await executePurge(doc, user, new Date(), { notifyAdmins: false });
    const fresh = await AgentSubscription.findById(doc._id).populate('user', 'email name').populate('purgedBy', 'email name').lean();
    return res.json({ status, item: mapRow(fresh) });
  } catch (err) {
    return next(err);
  }
});

/** POST /v1/admin/agent-purges/:id/done — body { note } — operator confirms the runtime data was deleted. */
router.post('/:id/done', async (req, res, next) => {
  try {
    const doc = await loadExpired(req.params.id, res);
    if (!doc) return undefined;
    const note = String(req.body?.note || '').trim();
    if (note.length < 5) return res.status(400).json({ message: 'Describe what was deleted (at least 5 characters).' });
    const user = await User.findById(doc.user).select('email name role').lean();
    await markPurged(doc, user, new Date(), { by: req.user._id, note });
    const fresh = await AgentSubscription.findById(doc._id).populate('user', 'email name').populate('purgedBy', 'email name').lean();
    return res.json({ status: 'done', item: mapRow(fresh) });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

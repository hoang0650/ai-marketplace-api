const express = require('express');
const HiredAgent = require('../models/HiredAgent');
const { authenticate } = require('../middleware/auth');
const {
  AGENT_IDS,
  BYOK_ONLY_AGENTS,
  monthlyFee,
  listSubscriptions,
  getSubscriptionStatus,
  setAutoRenew,
  subscribeAgent,
  refundFailedRental,
} = require('../finance/agent-subscription');
const { AIMARKETS_PROVIDER_MARKUP } = require('../utils/openclaw-pricing');

const router = express.Router();

/** Client-safe shape (matches the web `HiredAgent` model). */
function mapHired(doc) {
  return {
    id: doc._id.toString(),
    agentId: doc.agentId,
    slug: doc.slug,
    name: doc.name,
    status: doc.status,
    version: doc.version || '',
    model: doc.model || '',
    launchedAt: (doc.launchedAt || doc.createdAt || new Date()).toISOString(),
    archivedAt: doc.archivedAt ? doc.archivedAt.toISOString() : undefined,
  };
}

function normalizeStatus(value) {
  const status = String(value || 'running').trim().toLowerCase();
  return HiredAgent.HIRED_STATUSES.includes(status) ? status : 'running';
}

/** GET /v1/agents/hired — the signed-in user's hired agents. */
router.get('/hired', authenticate, async (req, res, next) => {
  try {
    const rows = await HiredAgent.find({ user: req.user._id }).sort({ createdAt: -1 });
    res.json(rows.map(mapHired));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/agents/hired — record/refresh a hired agent.
 * Body: { agentId, slug, name, status?, version?, model? }
 */
router.post('/hired', authenticate, async (req, res, next) => {
  try {
    const { agentId, slug, name, status, version, model } = req.body || {};
    const id = String(agentId || slug || '').trim();
    if (!id) return res.status(400).json({ message: 'agentId is required' });

    const nextStatus = normalizeStatus(status);
    const row = await HiredAgent.findOneAndUpdate(
      { user: req.user._id, agentId: id },
      {
        $set: {
          slug: String(slug || id).trim(),
          name: String(name || id).trim(),
          status: nextStatus,
          version: String(version || '').trim(),
          model: String(model || '').trim(),
          launchedAt: new Date(),
          archivedAt: nextStatus === 'archived' ? new Date() : null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.json(mapHired(row));
  } catch (err) {
    next(err);
  }
});

/** PATCH /v1/agents/hired/:agentId — update status (archive / resume). */
router.patch('/hired/:agentId', authenticate, async (req, res, next) => {
  try {
    const agentId = String(req.params.agentId || '').trim();
    if (!agentId) return res.status(400).json({ message: 'agentId is required' });

    const update = {};
    if (req.body?.status !== undefined) {
      const nextStatus = normalizeStatus(req.body.status);
      update.status = nextStatus;
      update.archivedAt = nextStatus === 'archived' ? new Date() : null;
    }
    if (req.body?.name !== undefined) update.name = String(req.body.name).trim();
    if (req.body?.version !== undefined) update.version = String(req.body.version).trim();
    if (req.body?.model !== undefined) update.model = String(req.body.model).trim();

    const row = await HiredAgent.findOneAndUpdate(
      { user: req.user._id, agentId },
      { $set: update },
      { new: true },
    );
    if (!row) return res.status(404).json({ message: 'Hired agent not found' });
    res.json(mapHired(row));
  } catch (err) {
    next(err);
  }
});

const { runtimeAvailability } = require('../utils/agent-runtime-availability');
/** GET /v1/agents/pricing — public monthly price + token policy per hosted agent. */
router.get('/pricing', (_req, res) => {
  res.json(
    AGENT_IDS.map((agentId) => ({
      agentId,
      fee: monthlyFee(agentId),
      tokenMarkup: AIMARKETS_PROVIDER_MARKUP,
      byokOnly: BYOK_ONLY_AGENTS.includes(agentId),
      availability: runtimeAvailability(agentId),
    })),
  );
});

/** GET /v1/agents/subscriptions — monthly plan status + price for every hosted agent. */
router.get('/subscriptions', authenticate, async (req, res, next) => {
  try {
    res.json(await listSubscriptions(req.user));
  } catch (err) {
    next(err);
  }
});

/** GET /v1/agents/subscriptions/:agentId — one agent's plan status. */
router.get('/subscriptions/:agentId', authenticate, async (req, res, next) => {
  try {
    const status = await getSubscriptionStatus(req.user, req.params.agentId);
    if (!status) return res.status(404).json({ message: 'Unknown agent' });
    res.json(status);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/agents/subscriptions/:agentId — pay one month from the wallet
 * (new plan or renewal; paid days are stacked on the current expiry).
 */
router.post('/subscriptions/:agentId', authenticate, async (req, res, next) => {
  try {
    const idempotencyKey = req.get('Idempotency-Key') || req.body?.idempotencyKey;
    res.json(await subscribeAgent(req.user, req.params.agentId, { idempotencyKey }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/agents/subscriptions/:agentId/refund — body { walletTxId, reason }.
 * Refunds a just-made rental whose workspace failed to provision (once, own charge, 30 min window).
 */
router.post('/subscriptions/:agentId/refund', authenticate, async (req, res, next) => {
  try {
    res.json(await refundFailedRental(req.user, req.params.agentId, req.body?.walletTxId, { reason: req.body?.reason }));
  } catch (err) {
    next(err);
  }
});

/** PATCH /v1/agents/subscriptions/:agentId — body { autoRenew: boolean }. */
router.patch('/subscriptions/:agentId', authenticate, async (req, res, next) => {
  try {
    if (typeof req.body?.autoRenew !== 'boolean') {
      return res.status(400).json({ message: 'autoRenew (boolean) is required' });
    }
    const status = await setAutoRenew(req.user, req.params.agentId, req.body.autoRenew);
    if (!status) return res.status(404).json({ message: 'Unknown agent' });
    res.json(status);
  } catch (err) {
    next(err);
  }
});

/** DELETE /v1/agents/hired/:agentId — remove from My Agents. */
router.delete('/hired/:agentId', authenticate, async (req, res, next) => {
  try {
    const agentId = String(req.params.agentId || '').trim();
    const row = await HiredAgent.findOneAndDelete({ user: req.user._id, agentId });
    if (!row) return res.status(404).json({ message: 'Hired agent not found' });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

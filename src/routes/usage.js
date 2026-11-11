const express = require('express');
const UsageStat = require('../models/UsageStat');
const UsageEvent = require('../models/UsageEvent');
const WalletTx = require('../models/WalletTx');
const { authenticate, requireRoles } = require('../middleware/auth');
const {
  mapOpenClawTx,
  mapUsageEvent,
  summarizeUsageItems,
} = require('../utils/buyer-usage');

const router = express.Router();
const { usageUnitCatalog } = require('../finance/usage-units');
const { purchaseUsageAccess, hasActiveUsageEntitlement, quoteLedgerAmount } = require('../finance/usage-access');
const { currentFx } = require('../finance/vnd-quote');

/** Fixed per-unit codes, labels and which categories can meter them. */
router.get('/units', (req, res) => {
  res.json(usageUnitCatalog());
});

/** Buy one day/week/month/year access period. Calls are not metered after this. */
router.post('/access', authenticate, async (req, res, next) => {
  try {
    const { order, entitlement, unit } = await purchaseUsageAccess({
      buyer: req.user,
      productId: req.body?.productId,
    });
    const fx = await currentFx();
    const quoted = quoteLedgerAmount({
      amount: order.amount,
      currency: order.currency,
      vndPerUsd: fx.vndPerUsd,
      rateSource: fx.rateSource,
    });
    res.status(201).json({
      orderId: String(order._id),
      amount: quoted.amount,
      currency: quoted.currency,
      amountVnd: quoted.amountVnd,
      vndQuote: quoted.vndQuote,
      unit: unit.code,
      period: unit.period,
      startsAt: entitlement.startsAt,
      expiresAt: entitlement.expiresAt,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message, code: err.code });
    next(err);
  }
});

router.get('/access', authenticate, async (req, res, next) => {
  try {
    const row = await hasActiveUsageEntitlement(req.user._id, req.query.productId);
    res.json({ active: !!row, expiresAt: row?.expiresAt || null, unit: row?.unit || null });
  } catch (err) {
    next(err);
  }
});


/** Seller/admin aggregate stats (existing). */
router.get('/', authenticate, requireRoles('seller', 'admin'), async (req, res, next) => {
  try {
    const creatorId = req.user.role === 'admin' && req.query.creatorId
      ? req.query.creatorId
      : req.user._id;
    const rows = await UsageStat.find({ creator: creatorId }).sort({ date: 1 }).lean();
    res.json(
      rows.map((r) => ({
        date: r.date,
        tokens: r.tokens || 0,
        gpuHours: r.gpuHours || 0,
        requests: r.requests || 0,
        revenue: r.revenue || 0,
      }))
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Buyer usage history: OpenClaw wallet debits + product UsageEvent rows.
 * GET /v1/usage/me?limit=100
 */
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const buyerId = req.user._id;
    const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit) || 100)));

    const [events, txs] = await Promise.all([
      UsageEvent.find({ buyer: buyerId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate('product', 'name slug')
        .lean(),
      WalletTx.find({
        user: buyerId,
        type: 'debit',
        status: { $nin: ['failed', 'cancelled'] },
        $or: [
          { 'meta.channel': { $in: ['openclaw', 'hermes', 'nanoclaw'] } },
          { note: { $regex: /^(OpenClaw|Hermes)\b/i } },
        ],
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
    ]);

    const fromEvents = events.map(mapUsageEvent);
    const fromAgents = txs.map(mapOpenClawTx).filter(Boolean);
    const items = [...fromEvents, ...fromAgents]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);

    const summary = summarizeUsageItems(items);
    summary.totalCharged = Math.round(summary.totalCharged * 1e6) / 1e6;

    res.json({
      currency: items[0]?.currency || 'USD',
      summary,
      items,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

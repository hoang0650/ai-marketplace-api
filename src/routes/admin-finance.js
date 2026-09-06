const express = require('express');
const CommissionRule = require('../models/CommissionRule');
const TaxRule = require('../models/TaxRule');
const TaxWithholding = require('../models/TaxWithholding');
const SellerPayout = require('../models/SellerPayout');
const LedgerEntry = require('../models/LedgerEntry');
const Order = require('../models/Order');
const { authenticate, requireRoles } = require('../middleware/auth');
const { writeAuditLog } = require('../utils/audit');
const { createPayout, setPayoutStatus } = require('../finance/payout-engine');
const { PLATFORM_COMMISSION_RATE } = require('../finance/constants');

const router = express.Router();
const admin = [authenticate, requireRoles('admin')];

router.get('/revenue', ...admin, async (_req, res, next) => {
  try {
    const [paid] = await Order.aggregate([
      { $match: { status: { $in: ['paid', 'refunded'] } } },
      {
        $group: {
          _id: null,
          gmv: { $sum: '$amount' },
          commission: { $sum: { $ifNull: ['$commissionAmount', 0] } },
          platformRevenue: { $sum: { $ifNull: ['$platformRevenueAmount', '$platformFee'] } },
          tax: { $sum: { $ifNull: ['$taxAmount', 0] } },
          refund: { $sum: { $ifNull: ['$refundAmount', 0] } },
          chargeback: { $sum: { $ifNull: ['$chargebackAmount', 0] } },
          paymentFee: { $sum: { $ifNull: ['$paymentFeeAmount', 0] } },
          storeFee: { $sum: { $ifNull: ['$storeFeeAmount', 0] } },
        },
      },
    ]);
    const row = paid || {};
    res.json({
      grossGmv: row.gmv || 0,
      platformCommission: row.commission || 0,
      platformRevenue: row.platformRevenue || 0,
      paymentFees: row.paymentFee || 0,
      storeFees: row.storeFee || 0,
      refund: row.refund || 0,
      chargeback: row.chargeback || 0,
      taxWithheld: row.tax || 0,
      netPlatformRevenue: (row.platformRevenue || 0) - (row.refund || 0) * PLATFORM_COMMISSION_RATE,
      defaultCommissionRate: PLATFORM_COMMISSION_RATE,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/commission', ...admin, async (_req, res, next) => {
  try {
    const rules = await CommissionRule.find().sort({ createdAt: -1 }).lean();
    res.json(rules);
  } catch (err) {
    next(err);
  }
});

router.post('/commission-rules', ...admin, async (req, res, next) => {
  try {
    const doc = await CommissionRule.create({
      name: String(req.body?.name || 'Commission rule').slice(0, 200),
      rate: Number(req.body?.rate),
      appliesTo: req.body?.appliesTo || 'THIRD_PARTY_SELLER',
      categories: req.body?.categories || [],
      sellerTypes: req.body?.sellerTypes || [],
      sellerId: req.body?.sellerId || null,
      effectiveFrom: req.body?.effectiveFrom || new Date(),
      effectiveTo: req.body?.effectiveTo || null,
      status: req.body?.status || 'ACTIVE',
    });
    await writeAuditLog({
      actorId: req.user._id,
      actorRole: req.user.role,
      action: 'COMMISSION_RULE_CREATED',
      resourceType: 'CommissionRule',
      resourceId: doc._id,
      newValue: { rate: doc.rate, name: doc.name },
      ip: req.ip,
    });
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

router.put('/commission-rules/:id', ...admin, async (req, res, next) => {
  try {
    const doc = await CommissionRule.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Rule not found' });
    const before = doc.toObject();
    if (req.body.rate !== undefined) doc.rate = Number(req.body.rate);
    if (req.body.status) doc.status = req.body.status;
    if (req.body.effectiveTo !== undefined) doc.effectiveTo = req.body.effectiveTo;
    if (req.body.name) doc.name = req.body.name;
    await doc.save();
    await writeAuditLog({
      actorId: req.user._id,
      action: 'COMMISSION_RULE_CHANGED',
      resourceType: 'CommissionRule',
      resourceId: doc._id,
      oldValue: { rate: before.rate, status: before.status },
      newValue: { rate: doc.rate, status: doc.status },
      ip: req.ip,
    });
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

router.get('/store-fees', ...admin, async (_req, res, next) => {
  try {
    const StoreFeeRule = require('../models/StoreFeeRule');
    const rules = await StoreFeeRule.find().sort({ createdAt: -1 }).lean();
    res.json(rules);
  } catch (err) {
    next(err);
  }
});

router.get('/tax', ...admin, async (_req, res, next) => {
  try {
    const [rules, withheld] = await Promise.all([
      TaxRule.find().sort({ createdAt: -1 }).lean(),
      TaxWithholding.aggregate([
        {
          $group: {
            _id: '$status',
            amount: { $sum: '$withheldAmount' },
          },
        },
      ]),
    ]);
    res.json({
      rules,
      withholdingByStatus: Object.fromEntries((withheld || []).map((r) => [r._id, r.amount])),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/tax-rules', ...admin, async (req, res, next) => {
  try {
    const doc = await TaxRule.create({
      name: String(req.body?.name || 'Tax rule').slice(0, 200),
      taxType: String(req.body?.taxType || 'OTHER'),
      rate: Number(req.body?.rate),
      withholding: req.body?.withholding !== false,
      sellerTypes: req.body?.sellerTypes || [],
      sellerCountries: req.body?.sellerCountries || [],
      buyerCountries: req.body?.buyerCountries || [],
      taxCategories: req.body?.taxCategories || [],
      jurisdictions: req.body?.jurisdictions || [],
      effectiveFrom: req.body?.effectiveFrom || new Date(),
      status: req.body?.status || 'INACTIVE',
    });
    await writeAuditLog({
      actorId: req.user._id,
      action: 'TAX_RULE_CREATED',
      resourceType: 'TaxRule',
      resourceId: doc._id,
      newValue: { rate: doc.rate, taxType: doc.taxType },
      ip: req.ip,
    });
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

router.put('/tax-rules/:id', ...admin, async (req, res, next) => {
  try {
    const doc = await TaxRule.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Rule not found' });
    const before = { rate: doc.rate, status: doc.status };
    if (req.body.rate !== undefined) doc.rate = Number(req.body.rate);
    if (req.body.status) doc.status = req.body.status;
    if (req.body.effectiveTo !== undefined) doc.effectiveTo = req.body.effectiveTo;
    await doc.save();
    await writeAuditLog({
      actorId: req.user._id,
      action: 'TAX_RULE_CHANGED',
      resourceType: 'TaxRule',
      resourceId: doc._id,
      oldValue: before,
      newValue: { rate: doc.rate, status: doc.status },
      ip: req.ip,
    });
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

router.get('/reconciliation', ...admin, async (_req, res, next) => {
  try {
    const [orders, ledger] = await Promise.all([
      Order.aggregate([
        { $match: { status: { $in: ['paid', 'refunded'] } } },
        {
          $group: {
            _id: null,
            gmv: { $sum: '$amount' },
            commission: { $sum: { $ifNull: ['$commissionAmount', 0] } },
            sellerNet: { $sum: { $ifNull: ['$sellerNetAmount', '$sellerNet'] } },
            tax: { $sum: { $ifNull: ['$taxAmount', 0] } },
          },
        },
      ]),
      LedgerEntry.aggregate([
        {
          $group: {
            _id: '$type',
            credit: {
              $sum: { $cond: [{ $eq: ['$direction', 'credit'] }, '$amount', 0] },
            },
            debit: {
              $sum: { $cond: [{ $eq: ['$direction', 'debit'] }, '$amount', 0] },
            },
          },
        },
      ]),
    ]);
    res.json({
      orders: orders[0] || {},
      ledger: ledger || [],
    });
  } catch (err) {
    next(err);
  }
});

router.post('/payouts', ...admin, async (req, res, next) => {
  try {
    const result = await createPayout({
      sellerId: req.body?.sellerId,
      orderIds: req.body?.orderIds || [],
      payableAmount: Number(req.body?.payableAmount),
      taxAmount: Number(req.body?.taxAmount) || 0,
      commissionAmount: Number(req.body?.commissionAmount) || 0,
      paymentFee: Number(req.body?.paymentFee) || 0,
      storeFee: Number(req.body?.storeFee) || 0,
      currency: req.body?.currency || 'USD',
      actorId: req.user._id,
      idempotencyKey: req.body?.idempotencyKey || '',
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.put('/payouts/:payoutId', ...admin, async (req, res, next) => {
  try {
    const payout = await setPayoutStatus(req.params.payoutId, String(req.body?.status || '').toUpperCase(), {
      actorId: req.user._id,
      reason: req.body?.reason || '',
    });
    res.json(payout);
  } catch (err) {
    next(err);
  }
});

router.get('/payouts', ...admin, async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.sellerId) filter.sellerId = req.query.sellerId;
    if (req.query.status) filter.status = req.query.status;
    const rows = await SellerPayout.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

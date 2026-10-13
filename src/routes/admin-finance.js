const express = require('express');
const mongoose = require('mongoose');
const CommissionRule = require('../models/CommissionRule');
const TaxRule = require('../models/TaxRule');
const TaxWithholding = require('../models/TaxWithholding');
const SellerPayout = require('../models/SellerPayout');
const LedgerEntry = require('../models/LedgerEntry');
const Order = require('../models/Order');
const User = require('../models/User');
const WalletTx = require('../models/WalletTx');
const { authenticate, requireRoles } = require('../middleware/auth');
const { writeAuditLog } = require('../utils/audit');
const { createPayout, setPayoutStatus } = require('../finance/payout-engine');
const { PLATFORM_COMMISSION_RATE } = require('../finance/constants');
const { reviewWalletTx } = require('../utils/wallet-review');
const { mapWallet } = require('../utils/mappers');

const router = express.Router();
const admin = [authenticate, requireRoles('admin')];
/** Tax exports: admin or staff with the 'finance.tax' permission (kế toán thuế). */
const taxStaff = [authenticate, require('../middleware/auth').requireAdminPermission(require('../utils/roles').ADMIN_PERMISSION.TAX)];

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
    const rows = await SellerPayout.find(filter)
      .populate('sellerId', 'name email role')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

function escapeRegex(raw) {
  return String(raw || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

router.get('/wallet-txs', ...admin, async (req, res, next) => {
  try {
    const filter = {};
    const type = String(req.query.type || '').trim();
    if (type === 'deposit' || type === 'withdraw') filter.type = type;
    const status = String(req.query.status || '').trim().toLowerCase();
    if (['pending', 'failed', 'cancelled'].includes(status)) {
      filter.status = status;
    } else if (status === 'completed') {
      filter.$or = [{ status: 'completed' }, { status: { $exists: false } }, { status: null }];
    }
    const q = String(req.query.q || '').trim();
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      const users = await User.find({ $or: [{ email: rx }, { name: rx }] })
        .select('_id')
        .limit(50)
        .lean();
      filter.user = { $in: users.map((u) => u._id) };
    }
    const rows = await WalletTx.find(filter)
      .populate('user', 'name email role')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    const [pendingDeposits, pendingWithdraws] = await Promise.all([
      WalletTx.countDocuments({ type: 'deposit', status: 'pending' }),
      WalletTx.countDocuments({ type: 'withdraw', status: 'pending' }),
    ]);
    res.json({
      items: rows.map(mapWallet),
      pendingDeposits,
      pendingWithdraws,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/wallet-txs/:id', ...admin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid id' });
    }
    const row = await reviewWalletTx(req.params.id, req.body?.status, {
      actorId: req.user._id,
      note: req.body?.note || req.body?.reason || '',
    });
    res.json(row);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ message: err.message, code: err.code });
    }
    next(err);
  }
});

/**
 * Quarterly tax report (tax policy 2026-10): revenue of individual sellers + household businesses,
 * VAT/PIT withheld for individuals, PIT withheld from affiliates. ?year=2026&quarter=3&format=xlsx|csv|json
 * Submit on the tax authority portal in months 1, 4, 7, 10.
 */
router.get('/tax-reports/quarterly', ...taxStaff, async (req, res, next) => {
  try {
    const { buildQuarterlyReport, renderQuarterlyReport } = require('../finance/tax-report');
    const report = await buildQuarterlyReport({ year: req.query.year, quarter: req.query.quarter });
    const out = renderQuarterlyReport(report, req.query.format || 'xlsx');
    await writeAuditLog({
      actorId: req.user._id,
      actorRole: req.user.role,
      action: 'TAX_REPORT_EXPORTED',
      resourceType: 'TaxReport',
      newValue: { year: report.year, quarter: report.quarter, format: req.query.format || 'xlsx' },
    }).catch(() => {});
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(out.body);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ message: err.message });
    next(err);
  }
});

/** Year-end PIT withholding certificate data (chứng từ khấu trừ thuế TNCN). ?year=2026&format=xlsx|csv|json */
router.get('/tax-reports/pit-certificates', ...taxStaff, async (req, res, next) => {
  try {
    const { buildPitCertificates, renderPitCertificates } = require('../finance/tax-report');
    const year = Number(req.query.year);
    const rows = await buildPitCertificates({ year });
    const out = renderPitCertificates(rows, year, req.query.format || 'xlsx');
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(out.body);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ message: err.message });
    next(err);
  }
});

module.exports = router;

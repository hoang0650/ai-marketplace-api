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
    // Older withdrawals have no account on the tx: fall back to the user's saved payout account.
    const needAcc = rows.filter((r) => r.type === 'withdraw' && !r.meta?.payoutAccount && r.user?._id);
    if (needAcc.length) {
      const owners = await User.find({ _id: { $in: needAcc.map((r) => r.user._id) } })
        .select('payoutAccount')
        .lean();
      const byId = new Map(owners.map((u) => [String(u._id), u.payoutAccount]));
      for (const r of needAcc) {
        const a = byId.get(String(r.user._id));
        if (a && a.accountNumber) r.meta = { ...(r.meta || {}), payoutAccount: { ...a, source: 'saved' } };
      }
    }
    res.json({
      items: rows.map((r) => mapWallet(r, { admin: true })),
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

/** GET /v1/admin/invoices?status=pending|issued|cancelled&wants=yes|no&q= — per-order invoice records. */
router.get('/invoices', ...admin, async (req, res, next) => {
  try {
    const OrderInvoice = require('../models/OrderInvoice');
    const { mapInvoice } = require('../utils/invoice');
    const filter = {};
    const status = String(req.query.status || '').trim();
    if (['pending', 'issued', 'cancelled'].includes(status)) filter.status = status;
    const wants = String(req.query.wants || '').trim();
    if (wants === 'yes') filter.wantsInvoice = true;
    if (wants === 'no') filter.wantsInvoice = false;
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ buyerName: rx }, { taxCode: rx }, { email: rx }, { invoiceNumber: rx }, { productName: rx }];
      if (mongoose.isValidObjectId(q)) filter.$or.push({ order: q }, { _id: q }, { buyer: q });
    }
    const [rows, counts] = await Promise.all([
      OrderInvoice.find(filter).populate('buyer', 'name email').sort({ createdAt: -1 }).limit(200).lean(),
      OrderInvoice.aggregate([{ $group: { _id: { status: '$status', wants: '$wantsInvoice' }, n: { $sum: 1 } } }]),
    ]);
    const c = { pending: 0, issued: 0, cancelled: 0, pendingWanted: 0 };
    for (const x of counts) {
      c[x._id.status] = (c[x._id.status] || 0) + x.n;
      if (x._id.status === 'pending' && x._id.wants) c.pendingWanted += x.n;
    }
    res.json({ items: rows.map((r) => mapInvoice(r, { admin: true })), counts: c });
  } catch (err) {
    next(err);
  }
});

/** PUT /v1/admin/invoices/:id — mark issued (number/series/lookup code) or cancelled. */
router.put('/invoices/:id', ...admin, async (req, res, next) => {
  try {
    const OrderInvoice = require('../models/OrderInvoice');
    const { mapInvoice } = require('../utils/invoice');
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    const inv = await OrderInvoice.findById(req.params.id);
    if (!inv) return res.status(404).json({ message: 'Invoice not found' });
    const status = String(req.body?.status || '').trim();
    if (!['issued', 'pending', 'cancelled'].includes(status)) {
      return res.status(400).json({ message: 'status must be issued, pending or cancelled', code: 'INVALID_STATUS' });
    }
    if (status === 'issued') {
      const invoiceNumber = String(req.body?.invoiceNumber || '').trim().slice(0, 50);
      if (!invoiceNumber && !inv.pdfObjectName) {
        return res.status(400).json({ message: 'Invoice number or PDF is required to mark issued', code: 'INVOICE_NUMBER_REQUIRED' });
      }
      if (invoiceNumber) inv.invoiceNumber = invoiceNumber;
      inv.invoiceSeries = String(req.body?.invoiceSeries ?? inv.invoiceSeries ?? '').trim().slice(0, 20);
      inv.lookupCode = String(req.body?.lookupCode ?? inv.lookupCode ?? '').trim().slice(0, 100);
      inv.issuedAt = new Date();
      inv.issuedBy = req.user._id;
    }
    inv.status = status;
    await inv.save();
    await writeAuditLog({
      actorId: req.user._id,
      action: `invoice.${status}`,
      resourceType: 'OrderInvoice',
      resourceId: inv._id,
      newValue: { orderId: String(inv.order), status, invoiceNumber: inv.invoiceNumber },
    }).catch(() => {});
    res.json({ ok: true, invoice: mapInvoice(inv, { admin: true }) });
  } catch (err) {
    next(err);
  }
});

/** POST /v1/admin/invoices/:id/pdf — attach the issued invoice PDF (private MinIO, %PDF, ≤10MB). */
const invoiceUpload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
router.post('/invoices/:id/pdf', ...admin, (req, res, next) => {
  invoiceUpload.single('file')(req, res, async (upErr) => {
    try {
      if (upErr) {
        const tooBig = upErr.code === 'LIMIT_FILE_SIZE';
        return res.status(tooBig ? 413 : 400).json({ message: tooBig ? 'PDF must be 10MB or smaller' : upErr.message, code: upErr.code });
      }
      const OrderInvoice = require('../models/OrderInvoice');
      const { mapInvoice } = require('../utils/invoice');
      const { isPdfBuffer } = require('../utils/kyc-upload');
      const minio = require('../config/minio');
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
      const inv = await OrderInvoice.findById(req.params.id);
      if (!inv) return res.status(404).json({ message: 'Invoice not found' });
      if (!req.file || !isPdfBuffer(req.file.buffer)) {
        return res.status(400).json({ message: 'Upload a PDF file', code: 'INVOICE_MUST_BE_PDF' });
      }
      if (!minio.isMinioEnabled()) return res.status(503).json({ message: 'MinIO is not configured', code: 'MINIO_NOT_CONFIGURED' });
      const cfg = await minio.ensurePlaygroundBucket();
      const objectName = `${String(cfg.kycPrefix).replace(/\/kyc$/, '')}/invoices/${inv.order}/invoice-${Date.now()}.pdf`;
      await minio.getMinioClient().putObject(cfg.bucket, objectName, req.file.buffer, req.file.buffer.length, {
        'Content-Type': 'application/pdf',
        'Cache-Control': 'private, no-store',
      });
      inv.pdfObjectName = objectName;
      await inv.save();
      res.status(201).json({ ok: true, invoice: mapInvoice(inv, { admin: true }) });
    } catch (err) {
      next(err);
    }
  });
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

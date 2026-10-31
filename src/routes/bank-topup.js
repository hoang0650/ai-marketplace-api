/**
 * VietQR bank-transfer top-up, credited MANUALLY by an admin.
 * There is intentionally no webhook here: nothing auto-credits the wallet.
 *
 *   GET  /v1/wallet/bank-transfer/config
 *   POST /v1/wallet/bank-transfer          { amount, currency: 'USD'|'VND' }
 *   GET  /v1/wallet/bank-transfer          (my recent requests)
 *   GET  /v1/wallet/bank-transfer/:id
 *
 *   GET  /v1/admin/bank-deposits?status=pending|credited|cancelled|all&q=
 *   POST /v1/admin/bank-deposits/:id/credit   { note }
 *   POST /v1/admin/bank-deposits/:id/cancel   { note }
 */
const express = require('express');
const mongoose = require('mongoose');
const WalletTx = require('../models/WalletTx');
const User = require('../models/User');
const { authenticate, requireRoles } = require('../middleware/auth');
const { reviewWalletTx } = require('../utils/wallet-review');
const {
  KIND,
  publicBankInfo,
  createBankDeposit,
  listUserBankDeposits,
  getUserBankDeposit,
  mapBankDeposit,
} = require('../finance/bank-topup');

function sendErr(res, next, err) {
  if (err && err.status) return res.status(err.status).json({ message: err.message, code: err.code });
  return next(err);
}

const userRouter = express.Router();

userRouter.get('/config', authenticate, async (_req, res, next) => {
  try {
    res.json(await publicBankInfo());
  } catch (err) {
    sendErr(res, next, err);
  }
});

userRouter.post('/', authenticate, async (req, res, next) => {
  try {
    const out = await createBankDeposit(req.user._id, {
      amount: req.body?.amount,
      currency: req.body?.currency || 'USD',
    });
    res.status(201).json(out);
  } catch (err) {
    sendErr(res, next, err);
  }
});

userRouter.get('/', authenticate, async (req, res, next) => {
  try {
    res.json({ items: await listUserBankDeposits(req.user._id) });
  } catch (err) {
    sendErr(res, next, err);
  }
});

userRouter.get('/:id', authenticate, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    res.json(await getUserBankDeposit(req.user._id, req.params.id));
  } catch (err) {
    sendErr(res, next, err);
  }
});

const adminRouter = express.Router();
const admin = [authenticate, requireRoles('admin')];

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

adminRouter.get('/', ...admin, async (req, res, next) => {
  try {
    const filter = { type: 'deposit', 'meta.kind': KIND };
    const status = String(req.query.status || 'pending').toLowerCase();
    if (status === 'pending') filter.status = 'pending';
    else if (status === 'credited') filter.status = 'completed';
    else if (status === 'cancelled') filter.status = { $in: ['failed', 'cancelled'] };
    const q = String(req.query.q || '').trim();
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      const users = await User.find({ $or: [{ email: rx }, { name: rx }] }).select('_id').limit(50).lean();
      filter.$or = [{ 'meta.content': rx }, { user: { $in: users.map((u) => u._id) } }];
    }
    const rows = await WalletTx.find(filter).populate('user', 'name email').sort({ createdAt: -1 }).limit(200).lean();
    const items = await Promise.all(
      rows.map(async (r) => ({
        ...(await mapBankDeposit(r, undefined, { withQr: false })),
        user: r.user ? { id: String(r.user._id), name: r.user.name || '', email: r.user.email || '' } : null,
        reviewNote: r.reviewNote || '',
      }))
    );
    const pending = await WalletTx.countDocuments({ type: 'deposit', status: 'pending', 'meta.kind': KIND });
    res.json({ items, pending });
  } catch (err) {
    next(err);
  }
});

async function review(req, res, next, status) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    const tx = await WalletTx.findOne({ _id: req.params.id, 'meta.kind': KIND }).select('_id meta').lean();
    if (!tx) return res.status(404).json({ message: 'Bank deposit not found' });
    const note = String(req.body?.note || '').slice(0, 400);
    const label = status === 'completed' ? `${KIND} credited` : `${KIND} cancelled`;
    // Reuses the standard admin wallet review path (status change + notification + audit log).
    const row = await reviewWalletTx(req.params.id, status, {
      actorId: req.user._id,
      note: note ? `${label}: ${note}` : `${label} (${tx.meta?.content || ''})`,
    });
    res.json(row);
  } catch (err) {
    sendErr(res, next, err);
  }
}

adminRouter.post('/:id/credit', ...admin, (req, res, next) => review(req, res, next, 'completed'));
adminRouter.post('/:id/cancel', ...admin, (req, res, next) => review(req, res, next, 'cancelled'));

module.exports = { userRouter, adminRouter };

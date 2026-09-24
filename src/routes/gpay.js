const express = require('express');
const mongoose = require('mongoose');
const GpayVirtualAccount = require('../models/GpayVirtualAccount');
const WalletTx = require('../models/WalletTx');
const { authenticate } = require('../middleware/auth');
const { mapWallet } = require('../utils/mappers');
const { claimEvent } = require('../finance/idempotency');
const config = require('../config/env');
const {
  gpayEnabled,
  gpayVaEnabled,
  gpaySandbox,
  createVirtualAccount,
  queryVirtualAccount,
  verifyWebhookSignature,
  webhookUrl,
} = require('../utils/gpay-client');

const router = express.Router();

const roundMoney = (n) => Math.round((Number(n) || 0) * 100) / 100;

function publicAccount(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    accountNumber: doc.accountNumber,
    accountName: doc.accountName,
    bankCode: doc.bankCode,
    accountType: doc.accountType,
    status: doc.status,
    balanceVnd: Number(doc.balanceVnd) || 0,
    qrCode: doc.qrCode || '',
    openedAt: doc.openedAt ? new Date(doc.openedAt).toISOString() : null,
  };
}

/** Feature flag + display config for the deposit screens. */
router.get('/config', (_req, res) => {
  const enabled = gpayEnabled() && gpayVaEnabled();
  res.json({
    enabled,
    sandbox: gpaySandbox(),
    bankCode: config.gpayVaBankCode,
    accountType: config.gpayAccountType,
    minTopupVnd: Number(config.gpayMinTopupVnd) || 0,
    vndPerUsd: Number(config.gpayVndPerUsd) || 26000,
    merchantName: 'AI Markets',
    webhookUrl: webhookUrl(),
  });
});

/**
 * The caller's GPay Virtual Account. Creates one on first request so the
 * deposit screen can always show bank details + VietQR.
 */
router.post('/account', authenticate, async (req, res, next) => {
  try {
    if (!gpayVaEnabled()) {
      return res.status(503).json({ message: 'GPay is not configured', code: 'GPAY_NOT_CONFIGURED' });
    }

    const existing = await GpayVirtualAccount.findOne({ user: req.user._id, status: { $ne: 'closed' } });
    if (existing) return res.json({ success: true, created: false, account: publicAccount(existing) });

    // Stable per-user reference; also used as GPay's `map_id`.
    const mapId = String(req.user._id);
    const accountName = String(req.body?.accountName || req.user.name || req.user.email || 'AI Markets User').slice(0, 70);

    const created = await createVirtualAccount({
      accountName,
      mapId,
      mapType: 'CUSTOMER_ID',
      accountType: config.gpayAccountType,
      bankCode: config.gpayVaBankCode,
    });

    const doc = await GpayVirtualAccount.create({
      user: req.user._id,
      accountNumber: String(created.account_number || '').trim(),
      accountName: created.account_name || accountName,
      mapId,
      mapType: 'CUSTOMER_ID',
      bankCode: config.gpayVaBankCode,
      accountType: created.account_type || config.gpayAccountType,
      status: String(created.status || '').toLowerCase() === 'opened' ? 'open' : 'pending',
      balanceVnd: Number(created.balance) || 0,
      qrCode: created.qr_code || '',
      raw: created,
      openedAt: created.start_at ? new Date(created.start_at) : new Date(),
    });

    res.status(201).json({ success: true, created: true, account: publicAccount(doc) });
  } catch (err) {
    // A concurrent request may have won the unique index race.
    if (err?.code === 11000) {
      const existing = await GpayVirtualAccount.findOne({ user: req.user._id, status: { $ne: 'closed' } });
      if (existing) return res.json({ success: true, created: false, account: publicAccount(existing) });
    }
    next(err);
  }
});

/** Fetch (and refresh) the caller's Virtual Account from GPay. */
router.get('/account', authenticate, async (req, res, next) => {
  try {
    const doc = await GpayVirtualAccount.findOne({ user: req.user._id, status: { $ne: 'closed' } });
    if (!doc) return res.json({ success: true, account: null });

    if (gpayVaEnabled()) {
      try {
        const fresh = await queryVirtualAccount(doc.accountNumber);
        if (fresh && fresh.account_number) {
          doc.status = String(fresh.status || '').toLowerCase() === 'opened' ? 'open' : 'closed';
          doc.balanceVnd = Number(fresh.balance) || doc.balanceVnd;
          if (fresh.qr_code) doc.qrCode = fresh.qr_code;
          await doc.save();
        }
      } catch {
        /* non-fatal: return our cached copy */
      }
    }
    res.json({ success: true, account: publicAccount(doc) });
  } catch (err) {
    next(err);
  }
});

/** Wallet rows credited by GPay deposits (for the deposit history panel). */
router.get('/transactions', authenticate, async (req, res, next) => {
  try {
    const rows = await WalletTx.find({ user: req.user._id, paymentMethod: 'gpay' })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json(rows.map(mapWallet));
  } catch (err) {
    next(err);
  }
});

/**
 * GPay -> us: balance change / account close notifications (spec 3.3.7).
 * Idempotent: GPay retries; each `gpay_trans_id` credits the wallet once.
 */
router.post('/webhook', async (req, res, next) => {
  try {
    const payload = req.body || {};
    const action = String(payload.action || '').trim().toUpperCase();

    if (!verifyWebhookSignature(payload)) {
      return res.status(401).json({ message: 'Invalid GPay signature', code: 'GPAY_BAD_SIGNATURE' });
    }

    const accountNumber = String(payload.account_number || '').trim();
    if (!accountNumber) {
      return res.status(400).json({ message: 'account_number required', code: 'GPAY_NO_ACCOUNT' });
    }

    const va = await GpayVirtualAccount.findOne({ accountNumber });
    if (!va) {
      return res.status(404).json({ message: 'Unknown virtual account', code: 'GPAY_UNKNOWN_ACCOUNT' });
    }

    if (action === 'CLOSE_ACCOUNT') {
      va.status = 'closed';
      va.closedAt = new Date();
      await va.save();
      return res.json({ success: true, action: 'CLOSE_ACCOUNT' });
    }

    const amountVnd = Number(payload.amount) || 0;
    if (amountVnd <= 0) {
      return res.status(400).json({ message: 'amount must be > 0', code: 'GPAY_BAD_AMOUNT' });
    }

    const gpayTransId = String(payload.gpay_trans_id || payload.bank_transaction_id || '').trim();
    if (!gpayTransId) {
      return res.status(400).json({ message: 'gpay_trans_id required', code: 'GPAY_NO_TX' });
    }

    const { duplicate } = await claimEvent({
      eventId: `gpay_${gpayTransId}`,
      provider: 'gpay',
      kind: 'deposit',
    });
    if (duplicate) {
      const existing = await WalletTx.findOne({ gpayTransactionId: gpayTransId });
      return res.json({ success: true, duplicate: true, wallet: existing ? mapWallet(existing) : null });
    }

    const rate = Number(config.gpayVndPerUsd) > 0 ? Number(config.gpayVndPerUsd) : 26000;
    const amountUsd = roundMoney(amountVnd / rate);
    if (amountUsd <= 0) {
      return res.status(400).json({ message: 'Deposit amount rounds to zero', code: 'GPAY_BAD_AMOUNT' });
    }

    let tx;
    try {
      tx = await WalletTx.create({
        user: va.user,
        type: 'deposit',
        amount: amountUsd,
        currency: 'USD',
        status: 'completed',
        paymentMethod: 'gpay',
        gpayTransactionId: gpayTransId,
        gpayAccountNumber: accountNumber,
        note: payload.message
          ? `GPay VA ${accountNumber} · ${amountVnd.toLocaleString('vi-VN')} VND · ${payload.message}`
          : `GPay VA ${accountNumber} · ${amountVnd.toLocaleString('vi-VN')} VND`,
        meta: {
          channel: 'gpay',
          amountVnd,
          vndPerUsd: rate,
          bankTraceId: payload.bank_trace_id || '',
          bankTransactionId: payload.bank_transaction_id || '',
        },
        reviewedAt: new Date(),
      });
    } catch (err) {
      if (err?.code === 11000) {
        const existing = await WalletTx.findOne({ gpayTransactionId: gpayTransId });
        return res.json({ success: true, duplicate: true, wallet: existing ? mapWallet(existing) : null });
      }
      throw err;
    }

    va.balanceVnd = Number(va.balanceVnd || 0) + amountVnd;
    await va.save();

    res.json({ success: true, duplicate: false, creditedUsd: amountUsd, wallet: mapWallet(tx) });
  } catch (err) {
    next(err);
  }
});

/** Sandbox helper: simulate a bank transfer so the flow is testable without GPay. */
router.post('/sandbox/credit', authenticate, async (req, res, next) => {
  try {
    if (!gpaySandbox()) {
      return res.status(403).json({ message: 'Sandbox simulation is disabled', code: 'GPAY_NOT_SANDBOX' });
    }
    const va = await GpayVirtualAccount.findOne({ user: req.user._id, status: { $ne: 'closed' } });
    if (!va) return res.status(404).json({ message: 'Create a virtual account first', code: 'GPAY_NO_VA' });

    const amountVnd = Number(req.body?.amountVnd);
    if (!Number.isFinite(amountVnd) || amountVnd <= 0) {
      return res.status(400).json({ message: 'amountVnd must be > 0' });
    }

    const gpayTransId = `SIM${Date.now()}${new mongoose.Types.ObjectId().toString().slice(-6)}`;
    const rate = Number(config.gpayVndPerUsd) > 0 ? Number(config.gpayVndPerUsd) : 26000;
    const amountUsd = roundMoney(amountVnd / rate);

    const tx = await WalletTx.create({
      user: req.user._id,
      type: 'deposit',
      amount: amountUsd,
      currency: 'USD',
      status: 'completed',
      paymentMethod: 'gpay',
      gpayTransactionId: gpayTransId,
      gpayAccountNumber: va.accountNumber,
      note: `GPay sandbox credit · ${amountVnd.toLocaleString('vi-VN')} VND`,
      meta: { channel: 'gpay', sandbox: true, amountVnd, vndPerUsd: rate },
      reviewedAt: new Date(),
    });

    va.balanceVnd = Number(va.balanceVnd || 0) + amountVnd;
    await va.save();

    res.status(201).json({ success: true, creditedUsd: amountUsd, wallet: mapWallet(tx) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

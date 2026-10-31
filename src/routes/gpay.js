const express = require('express');
const mongoose = require('mongoose');
const GpayVirtualAccount = require('../models/GpayVirtualAccount');
const WalletTx = require('../models/WalletTx');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { mapWallet } = require('../utils/mappers');
const { claimEvent } = require('../finance/idempotency');
const { orderRequestId, resolveOrderEvent, settleOrderEvent, roundMoney } = require('../finance/gpayOrders');
const { isAdmin } = require('../utils/roles');
const { publicApiBase } = require('../config/googleAuth');
const config = require('../config/env');
const { getExchangeRates, fxAudit } = require('../finance/exchange-rate');
const {
  gpayEnabled,
  gpayFeatureEnabled,
  gpayPortalConfigured,
  gpayVaEnabled,
  gpayPortalEnabled,
  gpaySandbox,
  createVirtualAccount,
  queryVirtualAccount,
  initBill,
  getBillInfo,
  createQrPayment,
  verifyWebhookSignature,
  verifyRelaySecret,
  webhookUrl,
} = require('../utils/gpay-client');

const router = express.Router();

const MAX_TOPUP_VND = 500_000_000;
const APP_SCHEME = 'aimarkets';

async function rateQuote() {
  return getExchangeRates();
}

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

function publicOrder(tx) {
  return {
    requestId: tx.gpayRequestId,
    status: tx.status,
    channel: tx.meta?.channel || 'gpay',
    amountVnd: Number(tx.meta?.amountVnd) || 0,
    amountUsd: tx.amount,
    createdAt: tx.createdAt ? new Date(tx.createdAt).toISOString() : null,
  };
}

/**
 * Simulated credits mint real wallet balance, so they are admin-only unless
 * NODE_ENV is explicitly development/test (an unset NODE_ENV counts as deployed).
 */
function canSimulate(user) {
  if (!gpaySandbox()) return false;
  if (['development', 'test'].includes(String(process.env.NODE_ENV || '').trim())) return true;
  return isAdmin(user);
}

/**
 * GPAY_ENABLED feature flag (default OFF): reject creating new GPay payments.
 * Webhook / return / order-status routes are NOT gated so in-flight payments still settle.
 */
function requireGpayEnabled(_req, res, next) {
  if (gpayFeatureEnabled()) return next();
  return res.status(503).json({
    message: 'GPay top-up is temporarily disabled',
    code: 'GPAY_DISABLED',
  });
}

/** Validates `amountVnd` from the body; sends 400 and returns 0 when invalid. */
function readAmountVnd(req, res) {
  const amountVnd = Math.round(Number(req.body?.amountVnd) || 0);
  const min = Number(config.gpayMinTopupVnd) || 0;
  if (amountVnd <= 0 || amountVnd < min || amountVnd > MAX_TOPUP_VND) {
    res.status(400).json({ message: `amountVnd must be between ${min} and ${MAX_TOPUP_VND}`, code: 'GPAY_BAD_AMOUNT' });
    return 0;
  }
  return amountVnd;
}

/** Pending deposit whose `_id` also names the GPay order (`AIM<id>`). */
async function createPendingDeposit(user, amountVnd, channel) {
  const fx = await rateQuote();
  const rate = fx.vndPerUsd;
  const amountUsd = roundMoney(amountVnd / rate);
  const _id = new mongoose.Types.ObjectId();
  return WalletTx.create({
    _id,
    user: user._id,
    type: 'deposit',
    amount: amountUsd,
    currency: 'USD',
    status: 'pending',
    paymentMethod: 'gpay',
    gpayRequestId: orderRequestId(_id),
    note: `GPay ${channel === 'gpay_qr' ? 'QR' : 'gateway'} · ${amountVnd.toLocaleString('vi-VN')} VND`,
    meta: { channel, amountVnd, ...fxAudit(fx) },
  });
}

async function cancelDeposit(tx, reason) {
  await WalletTx.updateOne({ _id: tx._id, status: 'pending' }, { $set: { status: 'cancelled', note: reason } });
}

/**
 * Feature flag + display config for the deposit screens.
 * `available` keeps the method visible; `enabled` means merchant credentials are set.
 */
router.get('/config', optionalAuth, async (req, res, next) => {
  try {
    const portalEnabled = gpayPortalEnabled();
    const qrEnabled = gpayEnabled() && gpayVaEnabled();
    const enabled = portalEnabled || qrEnabled;
    const fx = await rateQuote();
    res.json({
      available: gpayFeatureEnabled(),
      featureEnabled: gpayFeatureEnabled(),
      enabled,
      portalEnabled,
      qrEnabled,
      sandbox: gpaySandbox(),
      canSimulate: enabled && canSimulate(req.user),
      bankCode: config.gpayVaBankCode,
      accountType: config.gpayAccountType,
      minTopupVnd: Number(config.gpayMinTopupVnd) || 0,
      vndPerUsd: fx.vndPerUsd,
      exchangeRateSource: fx.source,
      exchangeRateUpdatedAt: fx.updatedAt,
      merchantName: 'AI Markets',
      webhookUrl: webhookUrl(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Top up through GPay's payment gateway (ATM / international card / VA on
 * GPay's page). Returns `billUrl` to open; GPay redirects back to /v1/gpay/return.
 */
router.post('/checkout', requireGpayEnabled, authenticate, async (req, res, next) => {
  try {
    if (!gpayPortalEnabled()) {
      return res.status(503).json({ message: 'GPay gateway is not configured', code: 'GPAY_NOT_CONFIGURED' });
    }
    const amountVnd = readAmountVnd(req, res);
    if (!amountVnd) return;

    const tx = await createPendingDeposit(req.user, amountVnd, 'gpay_portal');
    const app = req.body?.platform === 'app' ? '1' : '0';
    const base = String(config.apiPublicUrl || publicApiBase(req)).replace(/\/+$/, '');
    const callbackUrl = `${base}/v1/gpay/return?order=${encodeURIComponent(tx.gpayRequestId)}&app=${app}`;

    let bill;
    try {
      bill = await initBill({
        requestId: tx.gpayRequestId,
        amountVnd,
        customerId: String(req.user._id).slice(-20),
        customerName: req.user.name || '',
        title: 'AI Markets wallet top-up',
        description: `Nap vi AI Markets ${tx.gpayRequestId}`,
        callbackUrl,
        embedData: tx.gpayRequestId,
      });
    } catch (err) {
      await cancelDeposit(tx, `GPay init-bill failed: ${err.message}`);
      throw err;
    }
    await WalletTx.updateOne({ _id: tx._id }, { $set: { gpayBillId: String(bill.bill_id || '') } });

    res.status(201).json({
      success: true,
      order: publicOrder(tx),
      billUrl: bill.bill_url || '',
      billId: bill.bill_id || '',
      expiredTime: bill.expired_time || null,
    });
  } catch (err) {
    next(err);
  }
});

/** Top up with a dynamic VietQR (GPay QR Payment); the webhook credits the wallet. */
router.post('/qr', requireGpayEnabled, authenticate, async (req, res, next) => {
  try {
    if (!gpayVaEnabled()) {
      return res.status(503).json({ message: 'GPay is not configured', code: 'GPAY_NOT_CONFIGURED' });
    }
    const amountVnd = readAmountVnd(req, res);
    if (!amountVnd) return;

    const tx = await createPendingDeposit(req.user, amountVnd, 'gpay_qr');
    let qr;
    try {
      qr = await createQrPayment({
        billId: tx.gpayRequestId,
        amountVnd,
        accountName: 'AI MARKETS',
        description: tx.gpayRequestId,
      });
    } catch (err) {
      await cancelDeposit(tx, `GPay qr-payment failed: ${err.message}`);
      throw err;
    }

    res.status(201).json({
      success: true,
      order: publicOrder(tx),
      qrCode: qr.qr_code || '',
      qrCodeImage: qr.qr_code_image || '',
      accountNumber: qr.account_number || '',
      accountName: qr.account_name || '',
      provider: qr.provider || '',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Order status for polling. Pending gateway bills are reconciled with
 * bill-info (signed like the webhook) in case the webhook was missed.
 */
router.get('/orders/:requestId', authenticate, async (req, res, next) => {
  try {
    let tx = await WalletTx.findOne({ gpayRequestId: String(req.params.requestId), user: req.user._id });
    if (!tx) return res.status(404).json({ message: 'GPay order not found', code: 'GPAY_UNKNOWN_ORDER' });

    // Reconcile even while GPAY_ENABLED is off, so bills created before the switch still settle.
    if (tx.status === 'pending' && tx.gpayBillId && gpayPortalConfigured()) {
      try {
        const info = await getBillInfo({ merchantOrderId: tx.gpayRequestId, gpayBillId: tx.gpayBillId });
        const event = verifyWebhookSignature(info) ? resolveOrderEvent(info) : null;
        if (event && event.outcome !== 'pending') {
          await settleOrderEvent(event, { WalletTx, vndPerUsd: (await rateQuote()).vndPerUsd });
          tx = await WalletTx.findById(tx._id);
        }
      } catch {
        /* non-fatal: report our current state */
      }
    }
    res.json({ success: true, order: publicOrder(tx), wallet: mapWallet(tx) });
  } catch (err) {
    next(err);
  }
});

/** GPay gateway redirect target: back to the web wallet or the app deep link. */
router.get('/return', (req, res) => {
  const order = encodeURIComponent(String(req.query.order || '').slice(0, 64));
  const query = `gpay=return&order=${order}`;
  if (String(req.query.app) === '1') return res.redirect(302, `${APP_SCHEME}://wallet?${query}`);
  const web = String(config.frontendUrl || 'https://aimarkets.vn').replace(/\/+$/, '');
  return res.redirect(302, `${web}/wallet?${query}`);
});

/**
 * The caller's GPay Virtual Account (legacy VA flow). Creates one on first request.
 */
router.post('/account', requireGpayEnabled, authenticate, async (req, res, next) => {
  try {
    if (!gpayVaEnabled()) {
      return res.status(503).json({ message: 'GPay is not configured', code: 'GPAY_NOT_CONFIGURED' });
    }

    const existing = await GpayVirtualAccount.findOne({ user: req.user._id, status: { $ne: 'closed' } });
    if (existing) return res.json({ success: true, created: false, account: publicAccount(existing) });

    // GPay's `map_id` is shared with PHHotel accounts (same merchant), hence the prefix.
    const mapId = `AIM${String(req.user._id)}`;
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

/** Legacy Virtual Account balance notification. */
async function handleVirtualAccountEvent(payload, res) {
  const action = String(payload.action || '').trim().toUpperCase();
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

  const fx = await rateQuote();
  const rate = fx.vndPerUsd;
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
        ...fxAudit(fx),
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

  return res.json({ success: true, duplicate: false, creditedUsd: amountUsd, wallet: mapWallet(tx) });
}

/**
 * GPay -> PHHotel webhook -> relayed here for `AIM…` orders / AI Markets VAs.
 * Idempotent: GPay resends until it gets HTTP 200.
 */
router.post('/webhook', async (req, res, next) => {
  try {
    const payload = req.body || {};

    if (!verifyRelaySecret(req.get('x-gpay-relay-secret'))) {
      return res.status(401).json({ message: 'Invalid relay secret', code: 'GPAY_BAD_RELAY' });
    }
    if (!verifyWebhookSignature(payload)) {
      return res.status(401).json({ message: 'Invalid GPay signature', code: 'GPAY_BAD_SIGNATURE' });
    }

    const event = resolveOrderEvent(payload);
    if (!event) return handleVirtualAccountEvent(payload, res);

    const { status, body } = await settleOrderEvent(event, { WalletTx, vndPerUsd: (await rateQuote()).vndPerUsd, mapWallet });
    return res.status(status).json(body);
  } catch (err) {
    next(err);
  }
});

/** Sandbox helper: simulate a payment so the flow is testable without GPay. */
router.post('/sandbox/credit', requireGpayEnabled, authenticate, async (req, res, next) => {
  try {
    if (!canSimulate(req.user)) {
      return res.status(403).json({ message: 'Sandbox simulation is disabled', code: 'GPAY_NOT_SANDBOX' });
    }
    const amountVnd = Number(req.body?.amountVnd);
    if (!Number.isFinite(amountVnd) || amountVnd <= 0) {
      return res.status(400).json({ message: 'amountVnd must be > 0' });
    }

    const gpayTransId = `SIM${Date.now()}${new mongoose.Types.ObjectId().toString().slice(-6)}`;
    const fx = await rateQuote();
    const rate = fx.vndPerUsd;
    const amountUsd = roundMoney(amountVnd / rate);

    const tx = await WalletTx.create({
      user: req.user._id,
      type: 'deposit',
      amount: amountUsd,
      currency: 'USD',
      status: 'completed',
      paymentMethod: 'gpay',
      gpayTransactionId: gpayTransId,
      note: `GPay sandbox credit · ${amountVnd.toLocaleString('vi-VN')} VND`,
      meta: { channel: 'gpay', sandbox: true, amountVnd, ...fxAudit(fx) },
      reviewedAt: new Date(),
    });

    res.status(201).json({ success: true, creditedUsd: amountUsd, wallet: mapWallet(tx) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

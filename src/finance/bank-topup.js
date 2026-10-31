const WalletTx = require('../models/WalletTx');
const { bankTransferConfig } = require('../config/bank-transfer');
const { buildVietQrPayload } = require('../utils/vietqr');
const { KIND, makeTransferContent, convertAmount } = require('./bank-topup-core');
const { getExchangeRates, fxAudit } = require('./exchange-rate');

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

async function qrDataUrl(payload) {
  try {
    // Optional dependency: rendered locally, no third-party image service.
    const QRCode = require('qrcode');
    return await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, width: 360 });
  } catch {
    return '';
  }
}

async function publicBankInfo(cfg = bankTransferConfig()) {
  const fx = await getExchangeRates();
  return {
    enabled: cfg.enabled,
    bankName: cfg.bankName,
    accountNumber: cfg.enabled ? cfg.accountNumber : '',
    accountName: cfg.enabled ? cfg.accountName : '',
    bin: cfg.bin,
    vndPerUsd: fx.vndPerUsd,
    exchangeRateSource: fx.source,
    exchangeRateUpdatedAt: fx.updatedAt,
    minVnd: cfg.minVnd,
    maxVnd: cfg.maxVnd,
    expireHours: cfg.expireHours,
  };
}

function isExpired(tx, now = Date.now()) {
  const exp = tx?.meta?.expiresAt ? new Date(tx.meta.expiresAt).getTime() : 0;
  return tx.status === 'pending' && exp > 0 && exp < now;
}

/** Public view of one bank deposit (status pending|credited|expired|cancelled). */
async function mapBankDeposit(tx, cfg = bankTransferConfig(), { withQr = true } = {}) {
  const m = tx.meta || {};
  let status = 'pending';
  if (tx.status === 'completed') status = 'credited';
  else if (tx.status === 'failed' || tx.status === 'cancelled') status = 'cancelled';
  else if (isExpired(tx)) status = 'expired';
  const payload =
    withQr && status === 'pending'
      ? buildVietQrPayload({ bin: m.bin || cfg.bin, accountNumber: m.accountNumber || cfg.accountNumber, amountVnd: m.amountVnd, content: m.content })
      : '';
  return {
    id: String(tx._id || tx.id),
    status,
    amountUsd: tx.amount,
    amountVnd: m.amountVnd,
    vndPerUsd: m.vndPerUsd,
    content: m.content,
    bankName: m.bankName || cfg.bankName,
    accountNumber: m.accountNumber || cfg.accountNumber,
    accountName: m.accountName || cfg.accountName,
    expiresAt: m.expiresAt || null,
    createdAt: tx.createdAt ? new Date(tx.createdAt).toISOString() : null,
    creditedAt: tx.status === 'completed' && tx.reviewedAt ? new Date(tx.reviewedAt).toISOString() : null,
    qrPayload: payload,
    qrImage: payload ? await qrDataUrl(payload) : '',
  };
}

async function createBankDeposit(userId, { amount, currency }, cfg = bankTransferConfig()) {
  if (!cfg.enabled) throw httpError(503, 'Bank transfer top-up is not configured', 'BANK_TOPUP_DISABLED');
  const fx = await getExchangeRates();
  const conv = convertAmount({ amount, currency }, fx.vndPerUsd);
  if (!conv) throw httpError(400, 'Invalid amount', 'INVALID_AMOUNT');
  if (conv.amountVnd < cfg.minVnd || conv.amountVnd > cfg.maxVnd) {
    throw httpError(400, `Amount must be between ${cfg.minVnd} and ${cfg.maxVnd} VND`, 'AMOUNT_OUT_OF_RANGE');
  }
  // Cap open requests per user to limit memo clutter on the statement.
  const open = await WalletTx.countDocuments({ user: userId, type: 'deposit', status: 'pending', 'meta.kind': KIND });
  if (open >= 5) throw httpError(429, 'Too many pending bank transfers. Please wait for confirmation.', 'TOO_MANY_PENDING');

  const expiresAt = new Date(Date.now() + cfg.expireHours * 3600 * 1000);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const content = makeTransferContent(userId);
    // eslint-disable-next-line no-await-in-loop
    const clash = await WalletTx.exists({ 'meta.kind': KIND, 'meta.content': content });
    if (clash) continue;
    // eslint-disable-next-line no-await-in-loop
    const tx = await WalletTx.create({
      user: userId,
      type: 'deposit',
      amount: conv.amountUsd,
      currency: 'USD',
      status: 'pending',
      paymentMethod: 'bank_transfer',
      note: `Bank transfer ${content}`,
      meta: {
        kind: KIND,
        channel: 'bank_transfer',
        content,
        amountVnd: conv.amountVnd,
        ...fxAudit(fx),
        bankName: cfg.bankName,
        bin: cfg.bin,
        accountNumber: cfg.accountNumber,
        accountName: cfg.accountName,
        expiresAt,
      },
    });
    return mapBankDeposit(tx, cfg);
  }
  throw httpError(500, 'Could not allocate a unique transfer content', 'CONTENT_COLLISION');
}

async function listUserBankDeposits(userId, cfg = bankTransferConfig()) {
  const rows = await WalletTx.find({ user: userId, 'meta.kind': KIND }).sort({ createdAt: -1 }).limit(20).lean();
  return Promise.all(rows.map((r) => mapBankDeposit(r, cfg, { withQr: false })));
}

async function getUserBankDeposit(userId, id, cfg = bankTransferConfig()) {
  const tx = await WalletTx.findOne({ _id: id, user: userId, 'meta.kind': KIND }).lean();
  if (!tx) throw httpError(404, 'Not found');
  return mapBankDeposit(tx, cfg);
}

module.exports = {
  KIND,
  publicBankInfo,
  createBankDeposit,
  listUserBankDeposits,
  getUserBankDeposit,
  mapBankDeposit,
  isExpired,
};

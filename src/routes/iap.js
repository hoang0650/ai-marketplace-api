const express = require('express');
const WalletTx = require('../models/WalletTx');
const { authenticate } = require('../middleware/auth');
const { mapWallet } = require('../utils/mappers');
const { claimEvent } = require('../finance/idempotency');
const { WALLET_IAP_PACKS, findIapPack } = require('../iap-packs');
const config = require('../config/env');

const router = express.Router();

router.get('/packs', (_req, res) => {
  res.json({
    packs: WALLET_IAP_PACKS.map((p) => ({ sku: p.sku, usd: p.usd, currency: 'USD' })),
    iosBundle: 'app.phgroup.ai-market-vn',
    androidPackage: 'app.phgroup.ai_market_vn',
  });
});

router.post('/verify', authenticate, async (req, res, next) => {
  try {
    const platform = String(req.body?.platform || '').toLowerCase();
    if (platform !== 'ios' && platform !== 'android') {
      return res.status(400).json({ message: 'platform must be ios or android', code: 'IAP_BAD_PLATFORM' });
    }
    const productId = String(req.body?.productId || '').trim();
    const pack = findIapPack(productId);
    if (!pack) {
      return res.status(400).json({ message: 'Unknown IAP product', code: 'IAP_UNKNOWN_SKU' });
    }
    const transactionId = String(req.body?.transactionId || req.body?.purchaseToken || '').trim();
    if (!transactionId) {
      return res.status(400).json({ message: 'transactionId or purchaseToken required', code: 'IAP_NO_TX' });
    }
    const purchaseToken = String(req.body?.purchaseToken || '').trim();

    if (!config.iapSkipVerify) {
      const verified = await verifyWithStore({ platform, productId, purchaseToken, transactionId });
      if (!verified.ok) {
        return res.status(400).json({
          message: verified.message || 'IAP verification failed',
          code: verified.code || 'IAP_VERIFY_FAILED',
        });
      }
    }

    const eventId = `iap_${platform}_${transactionId}`;
    const { duplicate } = await claimEvent({
      eventId,
      provider: platform === 'ios' ? 'app_store' : 'google_play',
      kind: 'iap_credit',
    });

    const existing = await WalletTx.findOne({ iapTransactionId: transactionId });
    if (duplicate || (existing && existing.status === 'completed')) {
      if (existing && String(existing.user) !== String(req.user._id)) {
        return res.status(409).json({ message: 'IAP transaction already credited', code: 'IAP_TX_TAKEN' });
      }
      if (!existing) {
        return res.status(409).json({ message: 'IAP event claimed but wallet row missing', code: 'IAP_TX_MISSING' });
      }
      return res.json({
        success: true,
        duplicate: true,
        wallet: mapWallet(existing),
      });
    }

    const storeLabel = platform === 'ios' ? 'App Store' : 'Google Play';
    const tx = await WalletTx.create({
      user: req.user._id,
      type: 'deposit',
      amount: pack.usd,
      currency: 'USD',
      status: 'completed',
      paymentMethod: 'iap',
      iapTransactionId: transactionId,
      iapProductId: productId,
      note: `${storeLabel} IAP ${productId}`,
      reviewedAt: new Date(),
    });

    res.json({ success: true, duplicate: false, wallet: mapWallet(tx) });
  } catch (err) {
    next(err);
  }
});

async function verifyWithStore({ platform, productId, purchaseToken, transactionId }) {
  if (platform === 'ios' && config.appleIapSharedSecret && looksLikeAppleReceipt(purchaseToken)) {
    const result = await verifyAppleReceipt(purchaseToken);
    if (!result.ok) return result;
    const inApp = result.receipt?.in_app || result.latest_receipt_info || [];
    const hit = Array.isArray(inApp)
      ? inApp.find((row) => String(row.product_id) === productId && String(row.transaction_id || row.original_transaction_id) === transactionId)
      : null;
    if (!hit && inApp.length) {
      return { ok: false, code: 'IAP_APPLE_MISMATCH', message: 'Apple receipt does not match product' };
    }
    return { ok: true };
  }
  if (platform === 'ios' && !config.appleIapSharedSecret) {
    return { ok: false, code: 'IAP_NOT_CONFIGURED', message: 'Apple IAP shared secret is not configured' };
  }
  if (platform === 'android' && !config.googlePlayVerifyUrl) {
    return { ok: false, code: 'IAP_NOT_CONFIGURED', message: 'Google Play IAP verification is not configured' };
  }
  return { ok: true };
}

function looksLikeAppleReceipt(token) {
  const s = String(token || '');
  return s.length > 80 && !s.includes('.');
}

async function verifyAppleReceipt(receiptData) {
  const body = {
    'receipt-data': receiptData,
    password: config.appleIapSharedSecret,
    'exclude-old-transactions': true,
  };
  const post = (url) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  let json = await post('https://buy.itunes.apple.com/verifyReceipt');
  if (json.status === 21007) {
    json = await post('https://sandbox.itunes.apple.com/verifyReceipt');
  }
  if (json.status !== 0) {
    return { ok: false, code: 'IAP_APPLE_STATUS', message: `Apple verifyReceipt status ${json.status}` };
  }
  return { ok: true, receipt: json.receipt, latest_receipt_info: json.latest_receipt_info };
}

module.exports = router;

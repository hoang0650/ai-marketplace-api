const express = require('express');
const WalletTx = require('../models/WalletTx');
const { authenticate } = require('../middleware/auth');
const { mapWallet } = require('../utils/mappers');
const { claimEvent } = require('../finance/idempotency');
const { WALLET_IAP_PACKS, findIapPack } = require('../iap-packs');
const { IOS_BUNDLE_ID, ANDROID_PACKAGE } = require('../iap/constants');
const { verifyAppleIap } = require('../iap/verify-apple');
const { verifyGoogleIap } = require('../iap/verify-google');
const config = require('../config/env');

const router = express.Router();

router.get('/packs', (_req, res) => {
  res.json({
    packs: WALLET_IAP_PACKS.map((p) => ({ sku: p.sku, usd: p.usd, currency: 'USD' })),
    iosBundle: IOS_BUNDLE_ID,
    androidPackage: ANDROID_PACKAGE,
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
    const clientTxId = String(req.body?.transactionId || req.body?.purchaseToken || '').trim();
    const purchaseToken = String(req.body?.purchaseToken || '').trim();
    const signedTransaction = String(req.body?.signedTransaction || '').trim();
    if (!clientTxId && !purchaseToken && !signedTransaction) {
      return res.status(400).json({ message: 'transactionId or purchaseToken required', code: 'IAP_NO_TX' });
    }

    let storeTxId = clientTxId || purchaseToken;
    if (!config.iapSkipVerify) {
      const verified = platform === 'ios'
        ? await verifyAppleIap({
          productId,
          transactionId: clientTxId,
          purchaseToken,
          signedTransaction,
        })
        : await verifyGoogleIap({
          productId,
          purchaseToken,
          packageName: req.body?.packageName,
        });
      if (!verified.ok) {
        return res.status(400).json({
          message: verified.message || 'IAP verification failed',
          code: verified.code || 'IAP_VERIFY_FAILED',
        });
      }
      if (verified.transactionId) storeTxId = verified.transactionId;
    }

    const eventId = `iap_${platform}_${storeTxId}`;
    const { duplicate } = await claimEvent({
      eventId,
      provider: platform === 'ios' ? 'app_store' : 'google_play',
      kind: 'iap_credit',
    });

    const existing = await WalletTx.findOne({ iapTransactionId: storeTxId });
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
      iapTransactionId: storeTxId,
      iapProductId: productId,
      note: `${storeLabel} IAP ${productId}`,
      reviewedAt: new Date(),
    });

    res.json({ success: true, duplicate: false, wallet: mapWallet(tx) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

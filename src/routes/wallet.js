const express = require('express');
const WalletTx = require('../models/WalletTx');
const { authenticate, requireRoles } = require('../middleware/auth');
const { mapWallet } = require('../utils/mappers');

const { MAX_TX_AMOUNT, normalizeAmount, getBalance, getAvailableBalance } = require('../utils/wallet');

const router = express.Router();

router.get('/', authenticate, async (req, res, next) => {
  try {
    const txs = await WalletTx.find({ user: req.user._id }).sort({ createdAt: -1 }).lean();
    res.json(txs.map(mapWallet));
  } catch (err) {
    next(err);
  }
});

router.get('/summary', authenticate, async (req, res, next) => {
  try {
    const summary = await getAvailableBalance(req.user._id);
    res.json({
      currency: 'USD',
      holdHours: require('../utils/payout-hold').HOLD_HOURS,
      ...summary,
    });
  } catch (err) {
    next(err);
  }
});

/** SePay / bank-transfer top-up is retired. Web uses PayPal; mobile uses IAP. */
router.post('/deposit', authenticate, (_req, res) => {
  res.status(410).json({
    code: 'SEPAY_DISABLED',
    message:
      'Bank transfer top-up is no longer available. Use PayPal on the website, or in-app purchase in the iOS/Android app.',
  });
});

router.post('/withdraw', authenticate, requireRoles('creator', 'admin'), async (req, res, next) => {
  try {
    const amount = normalizeAmount(req.body?.amount);
    if (amount === null) {
      return res.status(400).json({ message: `Invalid amount (0 < amount <= ${MAX_TX_AMOUNT})` });
    }
    const { available, held, balance } = await getAvailableBalance(req.user._id);
    if (amount > available) {
      return res.status(400).json({
        message: `Insufficient available balance. Ledger ${balance.toFixed(2)}, held ${held.toFixed(2)} (48h protection or open dispute on those orders only), available ${available.toFixed(2)}.`,
        code: 'PAYOUT_HELD',
        balance,
        held,
        available,
      });
    }
    const SellerProfile = require('../models/SellerProfile');
    const { createPayout } = require('../finance/payout-engine');
    const profile = await SellerProfile.findOne({ user: req.user._id }).lean();
    if (req.user.role !== 'admin') {
      const { canPayoutSeller } = require('../finance/payout-engine');
      const gate = canPayoutSeller(profile);
      if (!gate.ok) {
        return res.status(403).json({
          message: 'Payout on hold until seller verification/compliance is complete.',
          code: gate.holdReason || 'PAYOUT_ON_HOLD',
        });
      }
    }
    const { payout } = await createPayout({
      sellerId: req.user._id,
      payableAmount: amount,
      currency: 'USD',
      actorId: req.user._id,
      idempotencyKey: `wd_${req.user._id}_${amount}_${Date.now()}`,
    });
    if (payout.status === 'ON_HOLD' && req.user.role !== 'admin') {
      return res.status(403).json({
        message: payout.holdReason || 'Payout on hold',
        code: payout.holdReason,
        payoutId: payout.payoutId,
      });
    }
    const tx = await WalletTx.create({
      user: req.user._id,
      type: 'withdraw',
      amount,
      currency: 'USD',
      status: 'pending',
      payoutId: payout.payoutId,
      note: `Payout ${payout.payoutId}`,
    });
    res.status(201).json({ ...mapWallet(tx), payoutId: payout.payoutId });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

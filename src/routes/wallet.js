const express = require('express');
const WalletTx = require('../models/WalletTx');
const { authenticate, requireRoles } = require('../middleware/auth');
const { mapWallet } = require('../utils/mappers');

const { MAX_TX_AMOUNT, normalizeAmount, getBalance } = require('../utils/wallet');

const router = express.Router();

router.get('/', authenticate, async (req, res, next) => {
  try {
    const txs = await WalletTx.find({ user: req.user._id }).sort({ createdAt: -1 }).lean();
    res.json(txs.map(mapWallet));
  } catch (err) {
    next(err);
  }
});

/** Buyer top-up / nạp tiền vào ví */
router.post('/deposit', authenticate, async (req, res, next) => {
  try {
    const amount = normalizeAmount(req.body?.amount);
    if (amount === null) {
      return res.status(400).json({ message: `Invalid amount (0 < amount <= ${MAX_TX_AMOUNT})` });
    }
    const tx = await WalletTx.create({
      user: req.user._id,
      type: 'deposit',
      amount,
      currency: String(req.body?.currency || 'USD'),
      note: String(req.body?.note || 'Buyer wallet deposit'),
    });
    res.status(201).json(mapWallet(tx));
  } catch (err) {
    next(err);
  }
});

router.post('/withdraw', authenticate, requireRoles('creator', 'admin'), async (req, res, next) => {
  try {
    const amount = normalizeAmount(req.body?.amount);
    if (amount === null) {
      return res.status(400).json({ message: `Invalid amount (0 < amount <= ${MAX_TX_AMOUNT})` });
    }
    const balance = await getBalance(req.user._id);
    if (amount > balance) {
      return res.status(400).json({ message: `Insufficient balance (available: ${balance.toFixed(2)})` });
    }
    const tx = await WalletTx.create({
      user: req.user._id,
      type: 'withdraw',
      amount,
      currency: 'USD',
      note: 'Withdrawal request',
    });
    res.status(201).json(mapWallet(tx));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
